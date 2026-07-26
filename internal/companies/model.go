package companies

// Domain types and service handle for the company LLM helpers used by the
// local-first RPC surface. The browser owns persistence — this package no
// longer talks to a database.

import "github.com/ngochoang/career-planner/internal/sources/llm"

// Candidate is the LLM's tentative company inference, returned to the browser
// before the user confirms and stores it locally.
type Candidate struct {
	OfficialName string `json:"official_name"`
	Website      string `json:"website"`
	TechBlogURL  string `json:"tech_blog_url"`
	ATSURL       string `json:"ats_url"`
	ATSProvider  string `json:"ats_provider"`
	Reasoning    string `json:"reasoning"`
}

// Company carries the identifying fields other packages need when composing
// LLM prompts (e.g. dossiers). It intentionally omits IDs and timestamps —
// those live in the browser DB.
type Company struct {
	OfficialName string
	Website      string
	TechBlogURL  string
	ATSURL       string
	ATSProvider  string
}

// Service exposes LLM-backed helpers for the local-first company flow.
type Service struct {
	client llm.Client
}

// NewService constructs a companies service. A nil client is allowed and
// causes candidate helpers to return unenriched fallbacks.
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}
