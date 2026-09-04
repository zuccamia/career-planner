package applications

// Types for the applications LLM helpers exposed via the RPC surface.

import (
	"context"
	"encoding/json"

	"github.com/zuccamia/career-planner/internal/profile"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/util"
)

// ---- service ----

// Typed as functions so tests can stub without importing the concrete
// registry / scraper.
type (
	postingFetcher  func(ctx context.Context, url string) (ats.Posting, error)
	atsKnownChecker func(url string) bool
	markdownScraper func(ctx context.Context, url string) (string, error)
)

// Service resolves a posting URL and turns it into structured output.
type Service struct {
	client     llm.Client
	atsFetch   postingFetcher
	isKnownATS atsKnownChecker
	scrapePage markdownScraper
}

// ---- extract-job-description ----

// PostingSource is the minimum FetchPosting needs: a URL to fetch, an
// already-fetched raw string that short-circuits the fetch, and a locale for
// error-message translation.
type PostingSource struct {
	URL            string
	Raw            string
	OutputLanguage string
}

// JDExtractionInput is the request body for /api/applications/extract-job-description.
type JDExtractionInput struct {
	CompanyName       string
	RoleTitle         string
	JobPostingURL     string
	JobDescriptionRaw string
	OutputLanguage    string
}

func (in JDExtractionInput) posting() PostingSource {
	return PostingSource{URL: in.JobPostingURL, Raw: in.JobDescriptionRaw, OutputLanguage: in.OutputLanguage}
}

// JobDescriptionStructured is the normalized structured representation of one raw job description.
type JobDescriptionStructured struct {
	SchemaVersion  string     `json:"schema_version"`
	CompanyName    string     `json:"company_name"`
	RoleTitle      string     `json:"role_title"`
	RoleLevel      string     `json:"role_level"`
	EmploymentType string     `json:"employment_type"`
	Function       string     `json:"function,omitempty"`
	Season         string     `json:"season"`
	Year           int        `json:"year"`
	Locations      util.StringList `json:"locations"`
	LocationNotes  string     `json:"location_notes"`
	Salary         struct {
		Currency string `json:"currency"`
		Amount   string `json:"amount"`
	} `json:"salary"`
	ApplicationDeadline     string     `json:"application_deadline"`
	MinimumQualifications   util.StringList `json:"minimum_qualifications"`
	PreferredQualifications util.StringList `json:"preferred_qualifications"`
	Responsibilities        util.StringList `json:"responsibilities"`
	Languages               util.StringList `json:"languages"`
	Skills                  util.StringList `json:"skills"`
	Domains                 util.StringList `json:"domains"`
	Requirements            struct {
		TranscriptRequired bool            `json:"transcript_required"`
		WorkAuthorization  util.FlexString `json:"work_authorization"`
		Education          util.StringList `json:"education"`
		Majors             util.StringList `json:"majors"`
		Availability       util.StringList `json:"availability"`
	} `json:"requirements"`
	Summary   string `json:"summary"`
	Reasoning string `json:"reasoning"`
}

// ---- analyze-role-signals ----

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

// ---- analyze-fit ----

// AnalyzeFitInput: RoleSignals is the pre-digested rubric from
// AnalyzeRoleSignals — passed instead of raw JD so the fit prompt reasons off
// a clean, sectioned view of the role. Brags is opaque JSON (same convention
// as CompanyDossier), the ground truth for what the candidate has done.
type AnalyzeFitInput struct {
	RoleSignals    string           `json:"role_signals"`
	ATSKeywords    []string         `json:"ats_keywords,omitempty"`
	Profile        ProfileForTailor `json:"profile"`
	Brags          json.RawMessage  `json:"brags,omitempty"`
	OutputLanguage string           `json:"output_language"`
}

// AnalyzeFitResponse: unstructured markdown so prompt iteration doesn't
// require model changes.
type AnalyzeFitResponse struct {
	Fit string `json:"fit"`
}

// ---- tailor-rank-brags ----

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

// RankBragsInput is the request body for the rank endpoint. RoleSignals is the
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

// ---- tailor-draft-resume ----

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

// TailorInput is the composite endpoint's request body: unranked brags in one
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

// ---- internal ----

// extractionContext carries the fields sanitizeJobDescriptionStructured falls
// back to when the LLM omits them (company/role) or when we need extra text to
// infer level/employment type.
type extractionContext struct {
	CompanyName       string
	RoleTitle         string
	JobDescriptionRaw string
}
