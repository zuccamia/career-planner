package applications

// LLM-driven job description extraction used by the local-first RPC surface.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// Service composes the extraction prompt, optionally fetches the JD from a
// posting URL, and returns structured output. All persistence lives in the
// browser.
type Service struct {
	client   llm.Client
	fetchURL func(ctx context.Context, url string) (string, error)
}

// NewService constructs an applications service. A nil client causes
// ExtractJobDescriptionText to return an error — extraction is LLM-only.
func NewService(client llm.Client) *Service {
	return &Service{client: client, fetchURL: fetchJobPostingText}
}

// ExtractJobDescriptionTextInput is the DB-free input for JD extraction. Fields
// mirror the JSON body the browser POSTs to /api/applications/extract-job-description.
type ExtractJobDescriptionTextInput struct {
	CompanyName       string
	RoleTitle         string
	JobPostingURL     string
	JobDescriptionRaw string
}

// ExtractJobDescriptionText runs the JD extraction pipeline on raw text and
// returns the structured result plus the raw text used (which may have been
// fetched from JobPostingURL when the caller passed an empty raw).
func (s *Service) ExtractJobDescriptionText(ctx context.Context, input ExtractJobDescriptionTextInput) (JobDescriptionStructured, string, error) {
	if s.client == nil {
		return JobDescriptionStructured{}, "", fmt.Errorf("llm client is not configured")
	}
	raw := strings.TrimSpace(input.JobDescriptionRaw)
	if raw == "" {
		if strings.TrimSpace(input.JobPostingURL) == "" {
			return JobDescriptionStructured{}, "", errors.New("job description raw or posting URL is required")
		}
		if s.fetchURL == nil {
			return JobDescriptionStructured{}, "", errors.New("job posting fetcher is not configured")
		}
		fetched, err := s.fetchURL(ctx, input.JobPostingURL)
		if err != nil {
			return JobDescriptionStructured{}, "", fmt.Errorf("fetch job description from URL: %w", err)
		}
		raw = fetched
	}

	var out JobDescriptionStructured
	prompt := llm.Prompt{
		System: extractJobDescriptionSystemPrompt,
		User: fmt.Sprintf(
			extractJobDescriptionUserPrompt,
			input.CompanyName,
			input.RoleTitle,
			input.JobPostingURL,
			raw,
		),
	}
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return JobDescriptionStructured{}, "", err
	}
	return sanitizeJobDescriptionStructured(out, extractionContext{
		CompanyName:       input.CompanyName,
		RoleTitle:         input.RoleTitle,
		JobDescriptionRaw: raw,
	}), raw, nil
}
