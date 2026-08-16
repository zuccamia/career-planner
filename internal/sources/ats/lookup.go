package ats

// ATS lookup from a company website: map the domain via a scrape.Client and
// filter returned URLs against the provider host patterns loaded from
// ats-providers.json. Coverage depth varies by scrape backend — see
// docs/scraper.md.

import (
	"context"
	"net/url"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

// Mapper is the subset of scrape.Client needed for lookup. Kept local so
// tests can substitute a stub without importing the full scrape package.
type Mapper interface {
	Map(ctx context.Context, url string, opts scrape.ScrapeOptions) (*scrape.MapResult, error)
}

// LookupATSURL scans a domain map for the first URL matching a known ATS
// host pattern. Returns ("", "", nil) when no match is found — an absence
// of ATS is not an error; callers should treat it as "user needs to paste
// the URL manually."
func LookupATSURL(ctx context.Context, mapper Mapper, companyWebsite string) (atsURL, provider string, err error) {
	if mapper == nil || strings.TrimSpace(companyWebsite) == "" {
		return "", "", nil
	}
	res, err := mapper.Map(ctx, companyWebsite, scrape.ScrapeOptions{})
	if err != nil {
		return "", "", err
	}
	patterns := hostPatterns()
	for _, u := range res.URLs {
		host := safeHTTPHost(u)
		if host == "" {
			continue
		}
		for _, p := range patterns {
			if p.rx.MatchString(host) {
				return u, p.provider, nil
			}
		}
	}
	return "", "", nil
}

// safeHTTPHost returns the URL's hostname if it parses as an http(s) URL
// with a non-empty host, or "" otherwise. The scraper's Map can return any
// string it found in the page; we only trust ones we can also safely fetch.
func safeHTTPHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	return u.Hostname()
}
