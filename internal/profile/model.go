package profile

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Service exposes LLM-backed helpers for the profile domain: overview
// extraction, structured-résumé extraction, and brag-entry helpers (tag
// generation + résumé → brags extraction).
type Service struct {
	client llm.Client
}

// NewService constructs a profile service.
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}

// =============================================================================
// Overview
// =============================================================================

// Skill mirrors the browser-side hydrateSkills shape (name + optional years
// and level). Levels outside SkillLevels are dropped in finalize.
type Skill struct {
	Name  string `json:"name"`
	Years *int   `json:"years,omitempty"`
	Level string `json:"level,omitempty"`
}

// ImportedOverview is the decoded LLM response for résumé → profile-overview
// extraction. Every field is optional; the browser presents non-empty ones for
// per-field accept/reject before writing anything.
type ImportedOverview struct {
	Name          string   `json:"name,omitempty"`
	Headline      string   `json:"headline,omitempty"`
	Summary       string   `json:"summary,omitempty"`
	WorkplaceType string   `json:"workplace_type,omitempty"`
	Skills        []Skill  `json:"skills,omitempty"`
	Tools         []string `json:"tools,omitempty"`
}

// SkillLevels mirrors web/static/js/entities/profile-overview.mjs
// SKILL_LEVELS. Kept here so finalizeImportedOverview can drop unknown values.
var SkillLevels = map[string]struct{}{
	"beginner":     {},
	"intermediate": {},
	"advanced":     {},
	"expert":       {},
}

// =============================================================================
// Brag entries
// =============================================================================

// BragTagResult is the decoded LLM response for brag-tag generation.
type BragTagResult struct {
	Tags []string `json:"tags"`
}

// ImportedBrag is one candidate brag entry the LLM proposes when reading
// an imported résumé. company / entry_year are soft: the browser UI
// presents them for review, and the applied row may or may not populate
// company_id / entry_year depending on whether a match is found.
// Category routes the brag into the matching résumé section on tailor.
type ImportedBrag struct {
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	Impact     string   `json:"impact"`
	Tags       []string `json:"tags"`
	Company    string   `json:"company,omitempty"`
	EntryYear  *int     `json:"entry_year,omitempty"`
	Category   string   `json:"category"`
	Confidence float64  `json:"confidence"`
}

// BragCategory namespaces the singular category tokens accepted for brag
// entries. Values must match migration 015's CHECK constraint and
// BRAG_CATEGORIES in web/static/js/entities/brag-entries.mjs.
var BragCategory = struct {
	Experience string
	Project    string
	Activity   string
}{
	Experience: "experience",
	Project:    "project",
	Activity:   "activity",
}

// BragCategoryOrder is the canonical iteration order — matches the résumé's
// section order and the JS `BRAG_CATEGORIES` array. Also serves as the
// valid-token list; call sites use slices.Contains(BragCategoryOrder, v).
var BragCategoryOrder = []string{BragCategory.Experience, BragCategory.Project, BragCategory.Activity}

// ImportBragsResult is the decoded LLM response for résumé-to-brags
// extraction.
type ImportBragsResult struct {
	Brags []ImportedBrag `json:"brags"`
}

// =============================================================================
// Structured résumé
// =============================================================================

// ResumeStructured is the decoded LLM response for structured-resume
// extraction — the shape the browser hands to a Typst renderer.
type ResumeStructured struct {
	Contact    ResumeContact      `json:"contact"`
	Education  []ResumeEducation  `json:"education,omitempty"`
	Skills     []ResumeSkillGroup `json:"skills,omitempty"`
	Experience []ResumeExperience `json:"experience,omitempty"`
	Projects   []ResumeNamedEntry `json:"projects,omitempty"`
	Activities []ResumeNamedEntry `json:"activities,omitempty"`
}

// Section namespaces the résumé section tokens the tailor pipeline routes
// changes into. Matches ResumeStructured JSON tags.
var Section = struct {
	Experience string
	Projects   string
	Activities string
}{
	Experience: "experience",
	Projects:   "projects",
	Activities: "activities",
}

// ResumeContact is the header block — name plus outward-facing links and
// locale. `Links` holds an ordered list of label/url pairs so callers keep
// the résumé's original presentation order (LinkedIn before GitHub, etc.).
type ResumeContact struct {
	Name     string       `json:"name,omitempty"`
	Email    string       `json:"email,omitempty"`
	Phone    string       `json:"phone,omitempty"`
	Location string       `json:"location,omitempty"`
	Links    []ResumeLink `json:"links,omitempty"`
}

type ResumeLink struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type ResumeEducation struct {
	School   string `json:"school"`
	Location string `json:"location,omitempty"`
	Degree   string `json:"degree,omitempty"`
	Dates    string `json:"dates,omitempty"`
}

// ResumeExperience is one role. `Division` is optional (e.g. the specific
// team within a company); `Bullets` are the per-role achievement items.
type ResumeExperience struct {
	Company  string                 `json:"company"`
	URL      string                 `json:"url,omitempty"`
	Location string                 `json:"location,omitempty"`
	Title    string                 `json:"title,omitempty"`
	Division string                 `json:"division,omitempty"`
	Dates    string                 `json:"dates,omitempty"`
	Bullets  []ResumeExperienceItem `json:"bullets,omitempty"`
}

// ResumeExperienceItem mirrors the Typst helper `rItem(leadIn, description)`
// — a bold prefix followed by continuation prose.
type ResumeExperienceItem struct {
	LeadIn      string `json:"lead_in,omitempty"`
	Description string `json:"description"`
}

type ResumeSkillGroup struct {
	Label string   `json:"label"`
	Items []string `json:"items"`
}

// ResumeNamedEntry is the shared shape for the Projects and Activities
// sections: a bold name (optionally linked), a subtitle (e.g. "Personal
// Project (2026)"), and a description.
type ResumeNamedEntry struct {
	Name        string `json:"name"`
	URL         string `json:"url,omitempty"`
	Subtitle    string `json:"subtitle,omitempty"`
	Description string `json:"description,omitempty"`
}
