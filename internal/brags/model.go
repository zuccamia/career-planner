package brags

import "github.com/zuccamia/career-planner/internal/sources/llm"

// TagResult is the decoded LLM response for brag-tag generation.
type TagResult struct {
	Tags []string `json:"tags"`
}

// ExtractedBrag is one candidate brag entry the LLM proposes when reading
// an imported résumé. company / entry_year are soft: the browser UI
// presents them for review, and the applied row may or may not populate
// company_id / entry_year depending on whether a match is found.
// Category routes the brag into the matching résumé section on tailor.
type ExtractedBrag struct {
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	Impact     string   `json:"impact"`
	Tags       []string `json:"tags"`
	Company    string   `json:"company,omitempty"`
	EntryYear  *int     `json:"entry_year,omitempty"`
	Category   string   `json:"category"`
	Confidence float64  `json:"confidence"`
}

// Category namespaces the singular category tokens accepted for brag entries.
// Values must match migration 015's CHECK constraint and BRAG_CATEGORIES in
// web/static/js/entities/brag-entries.mjs.
var Category = struct {
	Experience string
	Project    string
	Activity   string
}{
	Experience: "experience",
	Project:    "project",
	Activity:   "activity",
}

// CategoryOrder is the canonical iteration order — matches the résumé's
// section order and the JS `BRAG_CATEGORIES` array. Also serves as the
// valid-token list; call sites use slices.Contains(CategoryOrder, v).
var CategoryOrder = []string{Category.Experience, Category.Project, Category.Activity}

// ExtractResumeResult is the decoded LLM response for résumé-to-brags
// extraction.
type ExtractResumeResult struct {
	Brags []ExtractedBrag `json:"brags"`
}

// Service exposes LLM-backed helpers for generating brag-entry tags from body text.
type Service struct {
	client llm.Client
}

// NewService constructs a brags service.
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}
