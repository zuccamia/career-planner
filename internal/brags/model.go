package brags

import "github.com/zuccamia/career-planner/internal/sources/llm"

// TagResult is the decoded LLM response for brag-tag generation.
type TagResult struct {
	Tags []string `json:"tags"`
}

// Service exposes LLM-backed helpers for generating brag-entry tags from body text.
type Service struct {
	client llm.Client
}

// NewService constructs a brags service.
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}
