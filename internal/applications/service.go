package applications

// LLM-driven job description extraction used by the local-first RPC surface.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// postingFetcher retrieves a normalized job Posting for a URL. The service
// depends on this seam (not a concrete type) so tests can substitute a stub
// without touching the network.
type postingFetcher func(ctx context.Context, url string) (ats.Posting, error)

// Service composes the extraction prompt, optionally fetches the JD from a
// posting URL via an ATS provider, and returns structured output. All
// persistence lives in the browser.
type Service struct {
	client       llm.Client
	fetchPosting postingFetcher
}

// NewService constructs an applications service. A nil client causes
// ExtractJobDescriptionText to return an error — extraction is LLM-only.
func NewService(client llm.Client) *Service {
	registry := ats.NewRegistry(ats.NewGeneric(), ats.NewGreenhouse(), ats.NewLever(), ats.NewAshby())
	return &Service{client: client, fetchPosting: registry.Fetch}
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
	var posting ats.Posting
	if raw == "" {
		if strings.TrimSpace(input.JobPostingURL) == "" {
			return JobDescriptionStructured{}, "", errors.New("job description raw or posting URL is required")
		}
		if s.fetchPosting == nil {
			return JobDescriptionStructured{}, "", errors.New("job posting fetcher is not configured")
		}
		fetched, err := s.fetchPosting(ctx, input.JobPostingURL)
		if err != nil {
			return JobDescriptionStructured{}, "", fmt.Errorf("could not extract job description from %s: %w — paste the description text instead", input.JobPostingURL, err)
		}
		posting = fetched
		raw = strings.TrimSpace(posting.DescriptionText)
		if raw == "" {
			return JobDescriptionStructured{}, "", fmt.Errorf("no job description text found at %s — paste the description text instead", input.JobPostingURL)
		}
		// Fold structured ATS facts into the raw text so it's a self-contained
		// record. Otherwise metadata that lived only in JSON-LD (compensation,
		// department, etc.) would be lost on any later re-extraction from raw.
		raw = enrichRawWithATSMetadata(posting, input.JobPostingURL, raw)
	}

	var out JobDescriptionStructured
	prompt := llm.Prompt{
		System: extractJobDescriptionSystemPrompt,
		User: fmt.Sprintf(
			extractJobDescriptionUserPrompt,
			input.CompanyName,
			input.RoleTitle,
			input.JobPostingURL,
			buildATSHintsBlock(posting),
			raw,
		),
	}
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return JobDescriptionStructured{}, "", err
	}
	structured := sanitizeJobDescriptionStructured(out, extractionContext{
		CompanyName:       input.CompanyName,
		RoleTitle:         input.RoleTitle,
		JobDescriptionRaw: raw,
	})
	structured = overlayATSPosting(structured, posting)
	return structured, raw, nil
}

// enrichRawWithATSMetadata prepends a "Job details" preamble to the raw
// description so structured facts the ATS returned (compensation, location,
// etc.) survive being saved to disk and re-extracted later. On first extraction
// this is redundant with the hints block, but re-extraction sees only raw.
func enrichRawWithATSMetadata(p ats.Posting, sourceURL, description string) string {
	pairs := [][2]string{
		{"Role title", p.Title},
		{"Company", p.Company},
		{"Location", p.Location},
		{"Department", p.Department},
		{"Team", p.Team},
		{"Compensation", p.Compensation},
	}
	var lines []string
	if src := strings.TrimSpace(sourceURL); src != "" {
		sourceLine := "- Source: " + src
		if p.Provider != "" {
			sourceLine += " (via " + p.Provider + ")"
		}
		lines = append(lines, sourceLine)
	}
	for _, kv := range pairs {
		if v := strings.TrimSpace(kv[1]); v != "" {
			lines = append(lines, "- "+kv[0]+": "+v)
		}
	}
	if len(lines) == 0 {
		return description
	}
	return "Job details:\n" + strings.Join(lines, "\n") + "\n\n" + description
}

// buildATSHintsBlock renders whichever structured fields the ATS returned into
// a "known facts" block the LLM is told to trust verbatim. Returns "" when the
// ATS gave us nothing, so the prompt template collapses cleanly.
func buildATSHintsBlock(p ats.Posting) string {
	pairs := [][2]string{
		{"Role title", p.Title},
		{"Company", p.Company},
		{"Location", p.Location},
		{"Department", p.Department},
		{"Team", p.Team},
		{"Compensation", p.Compensation},
	}
	var lines []string
	for _, kv := range pairs {
		if v := strings.TrimSpace(kv[1]); v != "" {
			lines = append(lines, "- "+kv[0]+": "+v)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	header := "ATS-verified facts"
	if p.Provider != "" && p.Provider != "generic" {
		header = "ATS-verified facts (source: " + p.Provider + ")"
	}
	return "\n" + header + " (use verbatim, do not infer):\n" + strings.Join(lines, "\n") + "\n"
}

// overlayATSPosting prefers structured fields that an ATS provider returned
// authoritatively. The ATS wins over the LLM: title, company, and location come
// straight from the provider when non-empty, since the LLM can hallucinate them
// but the provider read them from the source of truth.
func overlayATSPosting(structured JobDescriptionStructured, posting ats.Posting) JobDescriptionStructured {
	if title := strings.TrimSpace(posting.Title); title != "" {
		structured.RoleTitle = title
	}
	if company := strings.TrimSpace(posting.Company); company != "" {
		structured.CompanyName = company
	}
	if location := strings.TrimSpace(posting.Location); location != "" && len(structured.Locations) == 0 {
		structured.Locations = []string{location}
	}
	if comp := strings.TrimSpace(posting.Compensation); comp != "" {
		currency, amount := splitCompensation(comp)
		if structured.Salary.Currency == "" {
			structured.Salary.Currency = currency
		}
		if structured.Salary.Amount == "" {
			structured.Salary.Amount = amount
		}
	}
	return structured
}

// splitCompensation parses a canonical compensation string produced by an ATS
// provider (e.g. "USD 11000/month" or "USD 98000-131000/year") into currency
// and amount pieces that match the JobDescriptionStructured.Salary schema
// (currency separate; amount excludes currency).
func splitCompensation(raw string) (currency, amount string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}
	if idx := strings.Index(trimmed, " "); idx > 0 {
		head := trimmed[:idx]
		rest := strings.TrimSpace(trimmed[idx+1:])
		// Treat the first token as a currency code only if it's all letters
		// (e.g. "USD", "EUR") — otherwise the whole string is the amount.
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
