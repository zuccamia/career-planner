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
type ExtractedBrag struct {
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	Impact     string   `json:"impact"`
	Tags       []string `json:"tags"`
	Company    string   `json:"company,omitempty"`
	EntryYear  *int     `json:"entry_year,omitempty"`
	Confidence float64  `json:"confidence"`
}

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
