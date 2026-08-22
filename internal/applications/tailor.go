package applications

// Résumé-tailoring service. Tailor composes rank → top-N → tailor.
// AnalyzeRoleSignals is the sibling background prep for the ranking rubric.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/profile"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// =============================================================================
// Wire shapes
// =============================================================================

// BragForRanking is the LLM's view of a brag — trimmed, no DB metadata.
// Category routes the brag into the matching résumé section (experience /
// project / activity) on tailor.
type BragForRanking struct {
	ID          int64    `json:"id"`
	Title       string   `json:"title,omitempty"`
	Body        string   `json:"body,omitempty"`
	Impact      string   `json:"impact,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	CompanyName string   `json:"company_name,omitempty"`
	EntryYear   int      `json:"entry_year,omitempty"`
	Category    string   `json:"category,omitempty"`
}

// ProfileForTailor is the résumé-shaping projection of profile_overview.
type ProfileForTailor struct {
	Headline string          `json:"headline,omitempty"`
	Summary  string          `json:"summary,omitempty"`
	Skills   []profile.Skill `json:"skills,omitempty"`
	Tools    []string        `json:"tools,omitempty"`
}

// RankBragsInput is the wire shape for the rank endpoint. RoleSignals is the
// cached rubric from AnalyzeRoleSignals.
type RankBragsInput struct {
	JDStructured         json.RawMessage          `json:"jd_structured"`
	Profile              ProfileForTailor         `json:"profile"`
	BaseResumeStructured profile.ResumeStructured `json:"base_resume_structured"`
	Brags                []BragForRanking         `json:"brags"`
	RoleSignals          string                   `json:"role_signals,omitempty"`
	OutputLanguage       string                   `json:"output_language"`
}

// SuggestedReplaces points at a base bullet the ranker recommends displacing
// (nil = no swap).
type SuggestedReplaces struct {
	BulletIndex int `json:"bullet_index"`
}

// RankedBrag is one row in the rank response. Relevance = brag-vs-brief fit in
// isolation; SwapPriority = marginal value if this brag displaces its weakest
// same-target bullet. TargetEntryIndex is a pointer so index 0 round-trips
// distinctly from "unset."
type RankedBrag struct {
	BragID                 int64              `json:"brag_id"`
	Relevance              float64            `json:"relevance"`
	SwapPriority           float64            `json:"swap_priority"`
	SignalsHit             []string           `json:"signals_hit,omitempty"`
	SignalsUncoveredByBase []string           `json:"signals_uncovered_by_base,omitempty"`
	TargetEntryIndex       *int               `json:"target_entry_index,omitempty"`
	SuggestedReplaces      *SuggestedReplaces `json:"suggested_replaces,omitempty"`
}

type RankBragsResponse struct {
	Ranked []RankedBrag `json:"ranked"`
}

// TailorChange audits one bullet/description edit. BragID > 0 cites a ranked
// brag; 0 = rephrase. BulletIndex is a pointer so null (description-level edit
// on projects/activities) round-trips distinctly from index 0.
type TailorChange struct {
	Section     string   `json:"section"`
	EntryIndex  int      `json:"entry_index"`
	BulletIndex *int     `json:"bullet_index,omitempty"`
	Before      string   `json:"before"`
	After       string   `json:"after"`
	BragID      int64    `json:"brag_id,omitempty"`
	Citations   []string `json:"citations,omitempty"`
	Reasoning   string   `json:"reasoning,omitempty"`
}

// TailorResumeResponse: no Title field — the client renders {company} — {role}
// deterministically, so an LLM title would be discarded anyway.
type TailorResumeResponse struct {
	Changes []TailorChange           `json:"changes,omitempty"`
	Resume  profile.ResumeStructured `json:"resume"`
}

// TailorInput is the composite endpoint's wire shape: unranked brags in one
// list. Server splits by category, ranks each (chunked if large), takes top-N,
// then runs the tailor prompt.
type TailorInput struct {
	JDStructured         json.RawMessage          `json:"jd_structured"`
	Profile              ProfileForTailor         `json:"profile"`
	BaseResumeStructured profile.ResumeStructured `json:"base_resume_structured"`
	RoleSignals          string                   `json:"role_signals,omitempty"`
	Brags                []BragForRanking         `json:"brags"`
	OutputLanguage       string                   `json:"output_language"`
}

// AnalyzeRoleSignalsInput.CompanyDossier is opaque JSON — the prompt just
// interpolates whatever fields the company row happens to have.
type AnalyzeRoleSignalsInput struct {
	JDStructured   json.RawMessage `json:"jd_structured"`
	CompanyDossier json.RawMessage `json:"company_dossier"`
	OutputLanguage string          `json:"output_language"`
}

// AnalyzeRoleSignalsResponse splits ATSKeywords from the markdown so downstream
// coverage checks don't have to re-parse.
type AnalyzeRoleSignalsResponse struct {
	Signals     string   `json:"signals"`
	ATSKeywords []string `json:"ats_keywords,omitempty"`
}

// =============================================================================
// Service methods
// =============================================================================

// rankBragsForJD scores brags on relevance + swap. Internal — Tailor
// validates client/JD/non-empty upstream.
func (s *Service) rankBragsForJD(ctx context.Context, in RankBragsInput) (RankBragsResponse, error) {
	profileJSON, _ := json.Marshal(in.Profile)
	bragsJSON, _ := json.Marshal(in.Brags)
	set := llm.PickPromptSet(tailorRankBragsPrompts(), in.OutputLanguage)
	prompt := llm.Prompt{
		System: buildPersonifiedSystem(set, in.JDStructured),
		User: fmt.Sprintf(
			set.User,
			in.RoleSignals,
			string(in.JDStructured),
			string(profileJSON),
			profile.FlattenBaseResume(in.BaseResumeStructured),
			string(bragsJSON),
		),
	}
	var raw RankBragsResponse
	if err := s.client.GenerateJSON(ctx, prompt, &raw); err != nil {
		return RankBragsResponse{}, err
	}
	return sanitizeRankBrags(raw, in.Brags), nil
}

// Tailor ranks brags per category, picks top-N, then drafts the résumé.
func (s *Service) Tailor(ctx context.Context, in TailorInput) (TailorResumeResponse, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return TailorResumeResponse{}, err
	}
	if err := validateJDForTailor(in.JDStructured, in.OutputLanguage); err != nil {
		return TailorResumeResponse{}, err
	}
	if len(in.Brags) == 0 {
		return TailorResumeResponse{}, noBragsErr(in.OutputLanguage)
	}
	ranked, err := s.rankAndSelectTopN(ctx, in)
	if err != nil {
		return TailorResumeResponse{}, err
	}
	profileJSON, _ := json.Marshal(in.Profile)
	baseJSON, _ := json.Marshal(in.BaseResumeStructured)
	expJSON, _ := json.Marshal(ranked[brags.Category.Experience])
	projJSON, _ := json.Marshal(ranked[brags.Category.Project])
	actJSON, _ := json.Marshal(ranked[brags.Category.Activity])
	set := llm.PickPromptSet(tailorDraftResumePrompts(), in.OutputLanguage)
	prompt := llm.Prompt{
		System: buildPersonifiedSystem(set, in.JDStructured),
		User: fmt.Sprintf(
			set.User,
			bulletWordCap,
			in.RoleSignals,
			string(in.JDStructured),
			string(profileJSON),
			string(baseJSON),
			string(expJSON),
			string(projJSON),
			string(actJSON),
		),
	}
	var raw TailorResumeResponse
	if err := s.client.GenerateJSON(ctx, prompt, &raw); err != nil {
		return TailorResumeResponse{}, err
	}
	return sanitizeTailorResume(raw, in.BaseResumeStructured, collectBragIDs(ranked)), nil
}

// rankAndSelectTopN fans out per-category rank goroutines; returns top-N
// per category keyed on brags.Category.* tokens.
func (s *Service) rankAndSelectTopN(ctx context.Context, in TailorInput) (map[string][]BragForRanking, error) {
	buckets := groupBragsByCategory(in.Brags)
	rankCtx := RankBragsInput{
		JDStructured:         in.JDStructured,
		Profile:              in.Profile,
		BaseResumeStructured: in.BaseResumeStructured,
		RoleSignals:          in.RoleSignals,
		OutputLanguage:       in.OutputLanguage,
	}
	type bucketResult struct {
		category string
		brags    []BragForRanking
		err      error
	}
	results := make(chan bucketResult, len(brags.CategoryOrder))
	for _, cat := range brags.CategoryOrder {
		go func(cat string) {
			bucket := buckets[cat]
			if len(bucket) == 0 {
				results <- bucketResult{category: cat}
				return
			}
			rankIn := rankCtx
			rankIn.Brags = bucket
			ranked, err := s.rankBucketChunked(ctx, rankIn)
			if err != nil {
				results <- bucketResult{category: cat, err: err}
				return
			}
			results <- bucketResult{category: cat, brags: selectTopNBrags(ranked, bucket, topNPerCategory)}
		}(cat)
	}
	out := make(map[string][]BragForRanking, len(brags.CategoryOrder))
	for range brags.CategoryOrder {
		r := <-results
		if r.err != nil {
			return nil, r.err
		}
		out[r.category] = r.brags
	}
	return out, nil
}

// AnalyzeRoleSignals returns the ranking rubric. Cached on
// applications.tailor_signals so subsequent tailors reuse it.
func (s *Service) AnalyzeRoleSignals(ctx context.Context, in AnalyzeRoleSignalsInput) (AnalyzeRoleSignalsResponse, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return AnalyzeRoleSignalsResponse{}, err
	}
	if err := validateJDForTailor(in.JDStructured, in.OutputLanguage); err != nil {
		return AnalyzeRoleSignalsResponse{}, err
	}
	set := llm.PickPromptSet(analyzeRoleSignalsPrompts(), in.OutputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, string(in.JDStructured), string(in.CompanyDossier)),
	}
	var raw AnalyzeRoleSignalsResponse
	if err := s.client.GenerateJSON(ctx, prompt, &raw); err != nil {
		return AnalyzeRoleSignalsResponse{}, err
	}
	return sanitizeRoleSignals(raw), nil
}

// =============================================================================
// Prompt helpers
// =============================================================================

// bulletWordCap must match BULLET_WORD_CAP in
// web/static/js/llm/parse/tailor-draft-resume.mjs.
const bulletWordCap = 40

// personaFunctionFallback plugs into the persona template when JD.function is
// empty. Mirrors PERSONA_FUNCTION_FALLBACK in the JS parsers.
const personaFunctionFallback = "professional"

// buildPersonifiedSystem sprintfs JD.function (or the fallback) into the
// prompt's Persona template, then into System's leading %s.
func buildPersonifiedSystem(set llm.Prompt, jd json.RawMessage) string {
	function := personaFunctionFallback
	if jd != nil {
		var probe struct {
			Function string `json:"function"`
		}
		if err := json.Unmarshal(jd, &probe); err == nil && probe.Function != "" {
			function = probe.Function
		}
	}
	return fmt.Sprintf(set.System, fmt.Sprintf(set.Persona, function))
}

// validateJDForTailor rejects unusable JD blobs before we pay for an LLM call.
// Mirrors the client's parsedJD heuristic.
func validateJDForTailor(jd json.RawMessage, locale string) error {
	trimmed := strings.TrimSpace(string(jd))
	if trimmed == "" || trimmed == "{}" || trimmed == "null" {
		return llm.NewInputError(i18n.T(locale, "applications.tailor.needs_jd"))
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(jd, &probe); err != nil {
		return llm.NewInputError(i18n.T(locale, "applications.tailor.error.jd_not_json"))
	}
	return nil
}

func noBragsErr(locale string) error {
	return llm.NewInputError(i18n.T(locale, "applications.tailor.error.no_brags_server"))
}

// =============================================================================
// Sanitizers — role signals
// =============================================================================

func sanitizeRoleSignals(raw AnalyzeRoleSignalsResponse) AnalyzeRoleSignalsResponse {
	signals := strings.TrimSpace(raw.Signals)
	if llm.IsSuspiciousText(signals) {
		log.Printf("analyze-role-signals suspicious-output dropped=1")
		return AnalyzeRoleSignalsResponse{}
	}
	return AnalyzeRoleSignalsResponse{
		Signals:     signals,
		ATSKeywords: dedupeATSKeywords(raw.ATSKeywords),
	}
}

// dedupeATSKeywords collapses case-insensitive duplicates, preserving
// first-seen casing and order (LLM sometimes emits both "PostgreSQL" and
// "postgresql").
func dedupeATSKeywords(raw []string) []string {
	if len(raw) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, term := range raw {
		trimmed := strings.TrimSpace(term)
		if trimmed == "" || llm.IsSuspiciousText(trimmed) {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// =============================================================================
// Sanitizers — rank
// =============================================================================

func sanitizeRankBrags(raw RankBragsResponse, inputBrags []BragForRanking) RankBragsResponse {
	valid := make(map[int64]struct{}, len(inputBrags))
	for _, brag := range inputBrags {
		if brag.ID > 0 {
			valid[brag.ID] = struct{}{}
		}
	}
	seen := make(map[int64]struct{}, len(raw.Ranked))
	out := make([]RankedBrag, 0, len(raw.Ranked))
	for _, row := range raw.Ranked {
		if row.BragID <= 0 {
			continue
		}
		if _, ok := valid[row.BragID]; !ok {
			continue
		}
		if _, ok := seen[row.BragID]; ok {
			continue
		}
		seen[row.BragID] = struct{}{}
		out = append(out, RankedBrag{
			BragID:                 row.BragID,
			Relevance:              clampScore(row.Relevance),
			SwapPriority:           clampScore(row.SwapPriority),
			SignalsHit:             sanitizeSignalList(row.SignalsHit),
			SignalsUncoveredByBase: sanitizeSignalList(row.SignalsUncoveredByBase),
			TargetEntryIndex:       nonNegIntPtr(row.TargetEntryIndex),
			SuggestedReplaces:      sanitizeSuggestedReplaces(row.SuggestedReplaces),
		})
	}
	// Sort by max(swap, relevance) desc; ties broken by relevance.
	sort.SliceStable(out, func(i, j int) bool {
		mi, mj := max(out[i].SwapPriority, out[i].Relevance), max(out[j].SwapPriority, out[j].Relevance)
		if mi != mj {
			return mi > mj
		}
		return out[i].Relevance > out[j].Relevance
	})
	return RankBragsResponse{Ranked: out}
}

// =============================================================================
// Sanitizers — tailor
// =============================================================================

// baseTextAt returns the base résumé's text at (section, entry, bullet).
// Assumes validTailorChangeIndex passed.
func baseTextAt(section string, entryIndex int, bulletIndex *int, base profile.ResumeStructured) string {
	switch section {
	case profile.Section.Experience:
		return base.Experience[entryIndex].Bullets[*bulletIndex].Description
	case profile.Section.Projects:
		return base.Projects[entryIndex].Description
	case profile.Section.Activities:
		return base.Activities[entryIndex].Description
	}
	return ""
}

// validTailorChangeIndex reports whether (section, entryIndex, bulletIndex)
// addresses a real slot in the base résumé. Experience requires a non-nil
// bullet_index in range; projects/activities are description-level so
// bullet_index must be nil.
func validTailorChangeIndex(section string, entryIndex int, bulletIndex *int, base profile.ResumeStructured) bool {
	if entryIndex < 0 {
		return false
	}
	switch section {
	case profile.Section.Experience:
		if entryIndex >= len(base.Experience) || bulletIndex == nil || *bulletIndex < 0 {
			return false
		}
		return *bulletIndex < len(base.Experience[entryIndex].Bullets)
	case profile.Section.Projects:
		return bulletIndex == nil && entryIndex < len(base.Projects)
	case profile.Section.Activities:
		return bulletIndex == nil && entryIndex < len(base.Activities)
	default:
		return false
	}
}

func sanitizeTailorResume(raw TailorResumeResponse, base profile.ResumeStructured, validBrags map[int64]struct{}) TailorResumeResponse {
	resume := profile.FinalizeStructuredResume(raw.Resume)
	changes := make([]TailorChange, 0, len(raw.Changes))
	dropped := 0
	for _, ch := range raw.Changes {
		if !validTailorChangeIndex(ch.Section, ch.EntryIndex, ch.BulletIndex, base) {
			dropped++
			continue
		}
		before := strings.TrimSpace(ch.Before)
		after := strings.TrimSpace(ch.After)
		if before == "" || after == "" || before == after {
			dropped++
			continue
		}
		if llm.IsSuspiciousText(before) || llm.IsSuspiciousText(after) {
			dropped++
			continue
		}
		if strings.TrimSpace(baseTextAt(ch.Section, ch.EntryIndex, ch.BulletIndex, base)) != before {
			dropped++
			continue
		}
		// Unknown/negative brag_id → drop the attribution, keep the edit.
		bragID := ch.BragID
		if _, ok := validBrags[bragID]; !ok {
			bragID = 0
		}
		changes = append(changes, TailorChange{
			Section:     ch.Section,
			EntryIndex:  ch.EntryIndex,
			BulletIndex: ch.BulletIndex,
			Before:      before,
			After:       after,
			BragID:      bragID,
			Citations:   sanitizeCappedList(ch.Citations, 3),
			Reasoning:   llm.SanitizeText(ch.Reasoning),
		})
	}
	if dropped > 0 {
		log.Printf("tailor-draft-resume suspicious-or-invalid-changes dropped=%d", dropped)
	}
	return TailorResumeResponse{Changes: changes, Resume: resume}
}

// =============================================================================
// Sanitizer helpers
// =============================================================================

// sanitizeCappedList trims, drops empty/suspicious, and caps at max. Nil on
// empty input or all-dropped.
func sanitizeCappedList(raw []string, max int) []string {
	if len(raw) == 0 {
		return nil
	}
	out := make([]string, 0, min(len(raw), max))
	for _, s := range raw {
		trimmed := strings.TrimSpace(s)
		if trimmed == "" || llm.IsSuspiciousText(trimmed) {
			continue
		}
		out = append(out, trimmed)
		if len(out) >= max {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// sanitizeSignalList caps at 8 — the rubric's per-row signal budget.
func sanitizeSignalList(raw []string) []string { return sanitizeCappedList(raw, 8) }

func nonNegIntPtr(p *int) *int {
	if p == nil || *p < 0 {
		return nil
	}
	return p
}

func sanitizeSuggestedReplaces(sr *SuggestedReplaces) *SuggestedReplaces {
	if sr == nil || sr.BulletIndex < 0 {
		return nil
	}
	return sr
}

func clampScore(raw float64) float64 {
	switch {
	case math.IsNaN(raw), raw < 0:
		return 0
	case raw > 1:
		return 1
	default:
		return raw
	}
}

// =============================================================================
// Composite orchestration helpers
// =============================================================================

// Chunking + top-N cutoffs. Must match web/static/js/tailor-client.mjs.
const (
	rankChunkThreshold = 40
	rankChunkSize      = 30
	topNPerCategory    = 12
)

// groupBragsByCategory bucketises brags; unknown categories → Experience.
func groupBragsByCategory(all []BragForRanking) map[string][]BragForRanking {
	out := make(map[string][]BragForRanking, len(brags.CategoryOrder))
	for _, cat := range brags.CategoryOrder {
		out[cat] = nil
	}
	for _, b := range all {
		cat := b.Category
		if _, ok := out[cat]; !ok {
			cat = brags.Category.Experience
		}
		out[cat] = append(out[cat], b)
	}
	return out
}

// rankBucketChunked ranks one bucket, chunking above rankChunkThreshold and
// re-sorting the merged result.
func (s *Service) rankBucketChunked(ctx context.Context, in RankBragsInput) ([]RankedBrag, error) {
	if len(in.Brags) <= rankChunkThreshold {
		resp, err := s.rankBragsForJD(ctx, in)
		return resp.Ranked, err
	}
	var all []RankedBrag
	for i := 0; i < len(in.Brags); i += rankChunkSize {
		end := i + rankChunkSize
		if end > len(in.Brags) {
			end = len(in.Brags)
		}
		chunkIn := in
		chunkIn.Brags = in.Brags[i:end]
		resp, err := s.rankBragsForJD(ctx, chunkIn)
		if err != nil {
			return nil, err
		}
		all = append(all, resp.Ranked...)
	}
	sort.SliceStable(all, func(i, j int) bool {
		return max(all[i].SwapPriority, all[i].Relevance) > max(all[j].SwapPriority, all[j].Relevance)
	})
	return all, nil
}

// selectTopNBrags maps the top-N ranked rows back to full brags (best first).
func selectTopNBrags(ranked []RankedBrag, bucket []BragForRanking, n int) []BragForRanking {
	byID := make(map[int64]BragForRanking, len(bucket))
	for _, b := range bucket {
		byID[b.ID] = b
	}
	out := make([]BragForRanking, 0, n)
	for _, row := range ranked {
		b, ok := byID[row.BragID]
		if !ok {
			continue
		}
		out = append(out, b)
		if len(out) >= n {
			break
		}
	}
	return out
}

// collectBragIDs flattens picked brag IDs into a set for citation validation.
func collectBragIDs(ranked map[string][]BragForRanking) map[int64]struct{} {
	total := 0
	for _, group := range ranked {
		total += len(group)
	}
	out := make(map[int64]struct{}, total)
	for _, group := range ranked {
		for _, b := range group {
			if b.ID > 0 {
				out[b.ID] = struct{}{}
			}
		}
	}
	return out
}

