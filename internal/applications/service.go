package applications

// JD extraction service. Fetches a posting URL (via ATS registry or scraper),
// assembles an LLM prompt, and sanitizes the response.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

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

// ExtractJD fetches the posting (if raw is empty), assembles the LLM prompt,
// calls the LLM, and returns the sanitized result plus the raw text used.
func (s *Service) ExtractJD(ctx context.Context, input JDExtractionInput) (JobDescriptionStructured, string, error) {
	if s.client == nil {
		return JobDescriptionStructured{}, "", fmt.Errorf("llm client is not configured")
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

func suspiciousJDWarning(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || !llm.IsSuspiciousText(trimmed) {
		return ""
	}
	return "Job description text appears to contain prompt-like or internal-instruction language. Results may be less reliable; review extracted fields carefully."
}

// enrichRawWithATSMetadata prepends a "Job details" preamble to the raw
// description so structured ATS facts survive being saved and re-extracted.
func enrichRawWithATSMetadata(p ats.Posting, sourceURL, description string) string {
	pairs := [][2]string{
		{"Role title", p.Title},
		{"Company", p.Company},
		{"Location", p.Location},
		{"Department", p.Department},
		{"Team", p.Team},
		{"Compensation", p.Compensation},
		{"Employment type", p.EmploymentType},
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

// buildATSHintsBlock renders ATS-returned fields as a "known facts" block the
// LLM is told to trust verbatim. Returns "" when the ATS gave us nothing.
func buildATSHintsBlock(p ats.Posting) string {
	pairs := [][2]string{
		{"Role title", p.Title},
		{"Company", p.Company},
		{"Location", p.Location},
		{"Department", p.Department},
		{"Team", p.Team},
		{"Compensation", p.Compensation},
		{"Employment type", p.EmploymentType},
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

// overlayATSPosting prefers ATS-provider fields over LLM-inferred ones for
// title, company, and location.
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
	// EmploymentType from ATS only overrides when the LLM left it blank AND
	// the ATS value maps cleanly to our enum. Unmapped values (e.g. Ashby's
	// INTERN, which we track as role_level instead) fall through to the LLM's
	// inference — the raw ATS value is already in the hints block for context.
	if structured.EmploymentType == "" {
		if et := normalizeEmploymentType(posting.EmploymentType); et != "" {
			structured.EmploymentType = et
		}
	}
	return structured
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
