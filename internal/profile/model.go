package profile

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Skill mirrors the browser-side hydrateSkills shape (name + optional years
// and level). Levels outside SKILL_LEVELS are dropped in finalize.
type Skill struct {
	Name  string  `json:"name"`
	Years *int    `json:"years,omitempty"`
	Level string  `json:"level,omitempty"`
}

// ExtractedOverview is the decoded LLM response for résumé → profile-overview
// extraction. Every field is optional; the browser presents non-empty ones for
// per-field accept/reject before writing anything.
type ExtractedOverview struct {
	Name        string   `json:"name,omitempty"`
	Headline    string   `json:"headline,omitempty"`
	Summary     string   `json:"summary,omitempty"`
	Environment string   `json:"environment,omitempty"`
	Skills      []Skill  `json:"skills,omitempty"`
	Tools       []string `json:"tools,omitempty"`
}

// Service exposes LLM-backed helpers for extracting profile-overview fields
// from an imported résumé.
type Service struct {
	client llm.Client
}

// NewService constructs a profile service.
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}

// SkillLevels mirrors web/static/js/entities/profile-overview.mjs
// SKILL_LEVELS. Kept here so FinalizeExtracted can drop unknown values.
var SkillLevels = map[string]struct{}{
	"beginner":     {},
	"intermediate": {},
	"advanced":     {},
	"expert":       {},
}
