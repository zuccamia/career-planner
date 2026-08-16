package scrape

import "time"

// ScrapeResult is the normalized output of a single-URL scrape. Providers map
// their own response shape into this struct so callers stay provider-agnostic.
type ScrapeResult struct {
	URL       string
	Markdown  string
	HTML      string // empty unless requested via ScrapeOptions.Formats
	Metadata  map[string]any
	Provider  string
	FetchedAt time.Time
}

// ScrapeOptions requests specific rendering / extraction behavior. Fields are
// best-effort — a provider may ignore an option it does not support.
type ScrapeOptions struct {
	Formats         []string // e.g. {"markdown"} or {"markdown","html"}. Default: markdown.
	OnlyMainContent bool     // strip nav/footer/ads
	WaitFor         int      // ms; JS-heavy sites
}

// MapResult is the normalized output of a domain-mapping call (Firecrawl
// /v1/map or Crawl4AI /v1/scan).
type MapResult struct {
	Domain    string
	URLs      []string
	Provider  string
	FetchedAt time.Time
}
