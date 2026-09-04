package applications

// Business logic for the applications LLM helpers: JD extraction, role-signal
// analysis, and the rank → top-N → tailor résumé pipeline.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/profile"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/util"
)

// ---- service ----

// NewService wires the LLM client, the ATS registry, the known-ATS predicate,
// and the optional server scraper. Nils are allowed; missing dependencies just
// disable the paths that would need them.
func NewService(client llm.Client, fetcher postingFetcher, isKnown atsKnownChecker, scraper markdownScraper) *Service {
	return &Service{
		client:     client,
		atsFetch:   fetcher,
		isKnownATS: isKnown,
		scrapePage: scraper,
	}
}

// ---- extract-job-description ----

// ExtractJD fetches the posting (if raw is empty), assembles the LLM prompt,
// calls the LLM, and returns the sanitized result plus the raw text used.
func (s *Service) ExtractJD(ctx context.Context, input JDExtractionInput) (JobDescriptionStructured, string, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return JobDescriptionStructured{}, "", err
	}
	raw, posting, err := s.FetchPosting(ctx, input.posting())
	if err != nil {
		return JobDescriptionStructured{}, "", err
	}
	if warning := suspiciousJDWarning(raw); warning != "" {
		log.Printf("extract-job-description suspicious-input warning=%q company=%q role=%q posting_url=%q", warning, strings.TrimSpace(input.CompanyName), strings.TrimSpace(input.RoleTitle), strings.TrimSpace(input.JobPostingURL))
	}
	set := llm.PickPromptSet(extractJobDescriptionPrompts(), input.OutputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User: fmt.Sprintf(
			set.User,
			input.CompanyName,
			input.RoleTitle,
			input.JobPostingURL,
			buildATSHintsBlock(posting),
			raw,
		),
	}
	var out JobDescriptionStructured
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return JobDescriptionStructured{}, "", err
	}
	structured := sanitizeJobDescriptionStructured(out, extractionContext{
		CompanyName:       input.CompanyName,
		RoleTitle:         input.RoleTitle,
		JobDescriptionRaw: raw,
	})
	return overlayATSPosting(structured, posting), raw, nil
}

// FetchPosting fetches a posting URL and returns the enriched raw text plus
// the ATS posting. Callers pass a pre-fetched Raw to skip the fetch.
//
// Routing:
//  1. Known ATS host (Greenhouse/Lever/Ashby): structured provider.
//  2. Unknown host + server scraper: direct scrape (works for JS-rendered).
//  3. Otherwise: registry's Generic HTTP fallback.
func (s *Service) FetchPosting(ctx context.Context, src PostingSource) (string, ats.Posting, error) {
	raw := strings.TrimSpace(src.Raw)
	if raw != "" {
		return raw, ats.Posting{}, nil
	}
	url := strings.TrimSpace(src.URL)
	if url == "" {
		return "", ats.Posting{}, errors.New(i18n.T(src.OutputLanguage, "applications.error.jd_input_required"))
	}
	if s.atsFetch == nil {
		return "", ats.Posting{}, errors.New("job posting fetcher is not configured")
	}
	var (
		posting ats.Posting
		err     error
	)
	switch {
	case s.isKnownATS != nil && s.isKnownATS(url):
		posting, err = s.atsFetch(ctx, url)
	case s.scrapePage != nil:
		posting, err = scrapeAsPosting(ctx, s.scrapePage, url)
	default:
		posting, err = s.atsFetch(ctx, url)
	}
	if err != nil {
		return "", ats.Posting{}, fmt.Errorf("%s: %w", i18n.T(src.OutputLanguage, "applications.error.jd_fetch_failed", url), err)
	}
	raw = strings.TrimSpace(posting.DescriptionText)
	if raw == "" {
		return "", ats.Posting{}, errors.New(i18n.T(src.OutputLanguage, "applications.error.jd_no_text", url))
	}
	// Fold structured ATS facts into raw so it stays self-contained after
	// storage; metadata that only lived in JSON-LD would otherwise be lost.
	return enrichRawWithATSMetadata(posting, url, raw), posting, nil
}

// DetectSuspiciousJDInput returns a soft warning when JD input contains
// prompt-like or internal-instruction language.
func DetectSuspiciousJDInput(raw string) string {
	return suspiciousJDWarning(raw)
}

// scrapeAsPosting wraps scraper markdown in an ats.Posting so downstream code
// can treat it identically to a registry-fetched posting.
func scrapeAsPosting(ctx context.Context, scraper markdownScraper, rawURL string) (ats.Posting, error) {
	md, err := scraper(ctx, rawURL)
	if err != nil {
		return ats.Posting{}, err
	}
	return ats.Posting{
		Provider:        "scrape",
		ApplyURL:        rawURL,
		DescriptionText: md,
	}, nil
}

// ---- analyze-role-signals ----

// AnalyzeRoleSignals returns the ranking rubric. Cached on
// applications.role_signals so subsequent tailors reuse it.
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

// ---- analyze-fit ----

// AnalyzeFit derives the profile-vs-role fit rubric. Cached on
// applications.profile_fit.
func (s *Service) AnalyzeFit(ctx context.Context, in AnalyzeFitInput) (AnalyzeFitResponse, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return AnalyzeFitResponse{}, err
	}
	if strings.TrimSpace(in.RoleSignals) == "" {
		return AnalyzeFitResponse{}, errors.New("role_signals is required")
	}
	profileJSON, _ := json.Marshal(in.Profile)
	brags := strings.TrimSpace(string(in.Brags))
	if brags == "" {
		brags = "[]"
	}
	rubric := strings.TrimSpace(in.RoleSignals)
	if len(in.ATSKeywords) > 0 {
		rubric = rubric + "\n\n### ATS keywords\n" + strings.Join(in.ATSKeywords, ", ")
	}
	set := llm.PickPromptSet(analyzeFitPrompts(), in.OutputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User: fmt.Sprintf(
			set.User,
			rubric,
			string(profileJSON),
			brags,
		),
	}
	var raw AnalyzeFitResponse
	if err := s.client.GenerateJSON(ctx, prompt, &raw); err != nil {
		return AnalyzeFitResponse{}, err
	}
	fit := strings.TrimSpace(raw.Fit)
	if llm.IsSuspiciousText(fit) {
		log.Printf("analyze-fit suspicious-output dropped=1")
		return AnalyzeFitResponse{}, nil
	}
	return AnalyzeFitResponse{Fit: fit}, nil
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

// ---- tailor-rank-brags ----

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
			Relevance:              util.Clamp01(row.Relevance),
			SwapPriority:           util.Clamp01(row.SwapPriority),
			SignalsHit:             sanitizeSignalList(row.SignalsHit),
			SignalsUncoveredByBase: sanitizeSignalList(row.SignalsUncoveredByBase),
			TargetEntryIndex:       util.NonNegIntPtr(row.TargetEntryIndex),
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

// ---- tailor-draft-resume ----

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
	expJSON, _ := json.Marshal(ranked[profile.BragCategory.Experience])
	projJSON, _ := json.Marshal(ranked[profile.BragCategory.Project])
	actJSON, _ := json.Marshal(ranked[profile.BragCategory.Activity])
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
// per category keyed on profile.BragCategory.* tokens.
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
	results := make(chan bucketResult, len(profile.BragCategoryOrder))
	for _, cat := range profile.BragCategoryOrder {
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
	out := make(map[string][]BragForRanking, len(profile.BragCategoryOrder))
	for range profile.BragCategoryOrder {
		r := <-results
		if r.err != nil {
			return nil, r.err
		}
		out[r.category] = r.brags
	}
	return out, nil
}

func sanitizeTailorResume(raw TailorResumeResponse, base profile.ResumeStructured, validBrags map[int64]struct{}) TailorResumeResponse {
	resume := profile.FinalizeImportedResume(raw.Resume)
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

// ---- helpers ----

// bulletWordCap must match BULLET_WORD_CAP in
// web/static/js/llm/parse/applications/tailor-draft-resume.mjs.
const bulletWordCap = 40

// personaFunctionFallback plugs into the persona template when JD.function is
// empty. Mirrors PERSONA_FUNCTION_FALLBACK in the JS parsers.
const personaFunctionFallback = "professional"

// Chunking + top-N cutoffs. Must match web/static/js/tailor-client.mjs.
const (
	rankChunkThreshold = 40
	rankChunkSize      = 30
	topNPerCategory    = 12
)

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

func sanitizeSuggestedReplaces(sr *SuggestedReplaces) *SuggestedReplaces {
	if sr == nil || sr.BulletIndex < 0 {
		return nil
	}
	return sr
}

// groupBragsByCategory bucketises brags; unknown categories → Experience.
func groupBragsByCategory(all []BragForRanking) map[string][]BragForRanking {
	out := make(map[string][]BragForRanking, len(profile.BragCategoryOrder))
	for _, cat := range profile.BragCategoryOrder {
		out[cat] = nil
	}
	for _, b := range all {
		cat := b.Category
		if _, ok := out[cat]; !ok {
			cat = profile.BragCategory.Experience
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

// splitCompensation parses "USD 98000/year" into currency + amount fields.
func splitCompensation(raw string) (currency, amount string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}
	if idx := strings.Index(trimmed, " "); idx > 0 {
		head := trimmed[:idx]
		rest := strings.TrimSpace(trimmed[idx+1:])
		if isCurrencyCode(head) {
			return strings.ToUpper(head), rest
		}
	}
	return "", trimmed
}

func isCurrencyCode(token string) bool {
	if token == "" {
		return false
	}
	for _, r := range token {
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') {
			return false
		}
	}
	return true
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
