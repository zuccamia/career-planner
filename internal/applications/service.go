package applications

// LLM-driven job description extraction used by the RPC surface.

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

// Typed as functions so tests can substitute stubs without pulling in the
// concrete registry / scraper.
type (
	postingFetcher  func(ctx context.Context, url string) (ats.Posting, error)
	atsKnownChecker func(url string) bool
	markdownScraper func(ctx context.Context, url string) (string, error)
)

// Service composes the extraction prompt, resolves the JD from a posting URL,
// and returns structured output. URL resolution follows an explicit routing
// order: known-ATS provider (structured fields) → server-side scraper if
// available → generic HTTP fetch (registry fallback). All persistence lives
// in the browser.
type Service struct {
	client       llm.Client
	fetchPosting postingFetcher
	isKnownATS   atsKnownChecker
	scrapePage   markdownScraper
}

// NewService constructs an applications service. Arguments:
//   - client: LLM client. Nil disables extraction entirely.
//   - fetcher: given a job-posting URL, returns the fetched Posting. Usually
//     ats.Registry.Fetch. Nil disables JD-from-URL (paste-text still works).
//   - isKnown: true when a URL matches a structured ATS provider (Greenhouse,
//     Lever, Ashby). Used to route between fetcher and scraper.
//   - scraper: given a URL, returns page content as markdown. Optional — when
//     nil, unknown-host URLs fall through to fetcher's Generic HTTP fallback
//     instead of using a real web scraper.
func NewService(client llm.Client, fetcher postingFetcher, isKnown atsKnownChecker, scraper markdownScraper) *Service {
	return &Service{
		client:       client,
		fetchPosting: fetcher,
		isKnownATS:   isKnown,
		scrapePage:   scraper,
	}
}

// scrapeAsPosting wraps a scraper's markdown output in an ats.Posting so it
// can flow through the same downstream code as a registry-fetched posting.
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

// ExtractJobDescriptionTextInput is the DB-free input for JD extraction. Fields
// mirror the JSON body the browser POSTs to /api/applications/extract-job-description.
type ExtractJobDescriptionTextInput struct {
	CompanyName       string
	RoleTitle         string
	JobPostingURL     string
	JobDescriptionRaw string
	// OutputLanguage selects the locale-specific prompt template; missing
	// locales fall back to English via PickPromptSet.
	OutputLanguage string
}

// JDExtractionContext carries the intermediate results of PrepareJDExtraction
// so a caller (hosted or BYOK) can call FinalizeJDExtraction later without
// re-fetching the posting URL. Opaque to the browser — treated as pass-through.
type JDExtractionContext struct {
	Prompt      llm.Prompt
	EnrichedRaw string
	Posting     ats.Posting
	Warning     string
}

// ExtractJobDescriptionText runs the JD extraction pipeline on raw text and
// returns the structured result plus the raw text used (which may have been
// fetched from JobPostingURL when the caller passed an empty raw). Composed
// from PrepareJDExtraction + FinalizeJDExtraction.
func (s *Service) ExtractJobDescriptionText(ctx context.Context, input ExtractJobDescriptionTextInput) (JobDescriptionStructured, string, error) {
	if s.client == nil {
		return JobDescriptionStructured{}, "", fmt.Errorf("llm client is not configured")
	}
	prep, err := s.PrepareJDExtraction(ctx, input)
	if err != nil {
		return JobDescriptionStructured{}, "", err
	}
	if prep.Warning != "" {
		log.Printf("extract-job-description suspicious-input warning=%q company=%q role=%q posting_url=%q", prep.Warning, strings.TrimSpace(input.CompanyName), strings.TrimSpace(input.RoleTitle), strings.TrimSpace(input.JobPostingURL))
	}
	var out JobDescriptionStructured
	if err := s.client.GenerateJSON(ctx, prep.Prompt, &out); err != nil {
		return JobDescriptionStructured{}, "", err
	}
	return s.FinalizeJDExtraction(out, input, prep), prep.EnrichedRaw, nil
}

// PrepareJDExtraction assembles the JD extraction prompt. Fetches the ATS
// posting when input.JobDescriptionRaw is empty. Returns the prompt plus the
// enriched raw text and posting so FinalizeJDExtraction can reuse them without
// a second fetch.
func (s *Service) PrepareJDExtraction(ctx context.Context, input ExtractJobDescriptionTextInput) (JDExtractionContext, error) {
	raw := strings.TrimSpace(input.JobDescriptionRaw)
	var posting ats.Posting
	if raw == "" {
		url := strings.TrimSpace(input.JobPostingURL)
		if url == "" {
			return JDExtractionContext{}, errors.New(i18n.T(input.OutputLanguage, "applications.error.jd_input_required"))
		}
		if s.fetchPosting == nil {
			return JDExtractionContext{}, errors.New("job posting fetcher is not configured")
		}
		// Routing order:
		//   1. Known ATS host (Greenhouse/Lever/Ashby) → structured provider,
		//      which extracts JSON-LD or ATS JSON with typed fields (title,
		//      compensation, department, ...) the LLM can rely on.
		//   2. Unknown host + server-side scraper (Firecrawl/Crawl4AI) →
		//      direct scrape; renders JS-heavy careers pages the Generic
		//      plain-HTTP fetcher would return empty for.
		//   3. Otherwise → fall through to fetchPosting, which uses the
		//      registry's Generic fallback (plain HTTP + JSON-LD/HTML strip).
		var (
			fetched ats.Posting
			err     error
		)
		switch {
		case s.isKnownATS != nil && s.isKnownATS(url):
			fetched, err = s.fetchPosting(ctx, url)
		case s.scrapePage != nil:
			fetched, err = scrapeAsPosting(ctx, s.scrapePage, url)
		default:
			fetched, err = s.fetchPosting(ctx, url)
		}
		if err != nil {
			return JDExtractionContext{}, fmt.Errorf("%s: %w", i18n.T(input.OutputLanguage, "applications.error.jd_fetch_failed", url), err)
		}
		posting = fetched
		raw = strings.TrimSpace(posting.DescriptionText)
		if raw == "" {
			return JDExtractionContext{}, errors.New(i18n.T(input.OutputLanguage, "applications.error.jd_no_text", url))
		}
		// Fold structured ATS facts into the raw text so it's a self-contained
		// record. Otherwise metadata that lived only in JSON-LD (compensation,
		// department, etc.) would be lost on any later re-extraction from raw.
		raw = enrichRawWithATSMetadata(posting, url, raw)
	}
	set := llm.PickPromptSet(extractJobDescriptionPrompts, input.OutputLanguage)
	return JDExtractionContext{
		Prompt: llm.Prompt{
			System: set.System,
			User: fmt.Sprintf(
				set.User,
				input.CompanyName,
				input.RoleTitle,
				input.JobPostingURL,
				buildATSHintsBlock(posting),
				raw,
			),
		},
		EnrichedRaw: raw,
		Posting:     posting,
		Warning:     suspiciousJDWarning(raw),
	}, nil
}

// DetectSuspiciousJDInput returns a soft warning when JD input appears to
// contain prompt-like or internal-instruction language.
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

// FinalizeJDExtraction sanitizes a decoded LLM result and overlays ATS-verified
// fields. Pure — no I/O.
func (s *Service) FinalizeJDExtraction(out JobDescriptionStructured, input ExtractJobDescriptionTextInput, prep JDExtractionContext) JobDescriptionStructured {
	structured := sanitizeJobDescriptionStructured(out, extractionContext{
		CompanyName:       input.CompanyName,
		RoleTitle:         input.RoleTitle,
		JobDescriptionRaw: prep.EnrichedRaw,
	})
	return overlayATSPosting(structured, prep.Posting)
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
