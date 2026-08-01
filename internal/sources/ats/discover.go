package ats

// ATS discovery from a company website: map the domain via scrape.Client and
// filter returned URLs against known ATS host patterns. Depth of coverage
// varies by backend — see docs/scraper.md.

import (
	"context"
	"net/url"
	"regexp"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

// Mapper is the subset of scrape.Client needed for discovery. Duplicated here
// so ats stays free of a hard dependency on scrape at the interface layer
// (tests can substitute a stub).
type Mapper interface {
	Map(ctx context.Context, url string, opts scrape.ScrapeOptions) (*scrape.MapResult, error)
}

// atsHostPattern pairs a host regexp with the provider name it identifies.
// Patterns match the *host* of a URL (not the full URL) so we can be
// case-insensitive and reject `?ref=…` tracking suffixes cleanly.
type atsHostPattern struct {
	Provider string
	Host     *regexp.Regexp
}

var atsHostPatterns = []atsHostPattern{
	{"greenhouse", regexp.MustCompile(`(?i)^(job-)?boards\.greenhouse\.io$|(?i)\.greenhouse\.io$`)},
	{"lever", regexp.MustCompile(`(?i)^jobs\.lever\.co$`)},
	{"ashby", regexp.MustCompile(`(?i)\.ashbyhq\.com$|^jobs\.ashbyhq\.com$`)},
	{"workday", regexp.MustCompile(`(?i)\.myworkdayjobs\.com$`)},
	{"smartrecruiters", regexp.MustCompile(`(?i)^jobs\.smartrecruiters\.com$`)},
	{"careers-subdomain", regexp.MustCompile(`(?i)^careers\.`)},
}

// DiscoverATSURL scans the domain map for a URL matching a known ATS pattern.
// Returns ("", "", nil) when no match is found — an absence of ATS is not an
// error, callers should treat it as "user needs to paste the URL manually."
func DiscoverATSURL(ctx context.Context, mapper Mapper, companyWebsite string) (atsURL, provider string, err error) {
	if mapper == nil || strings.TrimSpace(companyWebsite) == "" {
		return "", "", nil
	}
	res, err := mapper.Map(ctx, companyWebsite, scrape.ScrapeOptions{})
	if err != nil {
		return "", "", err
	}
	for _, u := range res.URLs {
		if !isSafeHTTPURL(u) {
			continue
		}
		host := hostOf(u)
		if host == "" {
			continue
		}
		for _, p := range atsHostPatterns {
			if p.Host.MatchString(host) {
				return u, p.Provider, nil
			}
		}
	}
	return "", "", nil
}

// isSafeHTTPURL rejects malformed URLs, non-http(s) schemes (data:, javascript:,
// mailto:, etc.), and URLs with no host. The scraper's Map can return any
// string it found in the page; we only trust ones the LLM prompt and later
// ValidateFetchURL can also safely handle.
func isSafeHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	return (scheme == "http" || scheme == "https") && u.Host != ""
}

// hostOf extracts a URL's hostname without pulling in net/url on the hot path
// for every candidate. Falls back to net/url when the shape is unusual.
func hostOf(rawURL string) string {
	rest := rawURL
	if i := strings.Index(rest, "://"); i > 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexAny(rest, "/?#"); i > 0 {
		rest = rest[:i]
	}
	if i := strings.Index(rest, "@"); i >= 0 {
		rest = rest[i+1:]
	}
	if i := strings.Index(rest, ":"); i > 0 {
		rest = rest[:i]
	}
	return rest
}
