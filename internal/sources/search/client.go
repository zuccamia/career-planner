// Package search wraps a web-search backend behind a single Go interface.
// Today the only backend is SearXNG (self-hosted); the shape mirrors
// internal/sources/scrape so future backends (Tavily, Brave) can slot in.
//
// This package is server-side only. The browser BYOK path does not currently
// use web search — the /api/discover endpoint that reaches for it is disabled
// when SEARCH_BASE_URL is unset.
package search

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/zuccamia/career-planner/internal/gcp"
)

// Result is the normalized shape returned by every backend.
type Result struct {
	URL     string
	Title   string
	Content string // snippet / summary
	Engine  string // e.g. "duckduckgo", "google" — populated when the backend reports it
	// PublishedAt is the search engine's best guess at when the page was
	// first indexed / published. Not the posting's real posted-at date;
	// use only as a fallback when a more authoritative source is absent.
	// Zero-value = unknown.
	PublishedAt time.Time
}

// Options requests specific search behavior. Fields are best-effort — a
// backend may ignore an option it does not support. Zero-value fields are
// omitted from the outbound query so backend defaults apply.
type Options struct {
	Limit      int      // max results the caller wants back
	Categories []string // SearXNG category filter (e.g. {"general"})
	Language   string   // ISO 639-1 preferred result language (e.g. "en")
	Engines    []string // whitelist of engines to fan out to for this query
	TimeRange  string   // freshness cutoff (see TimeRange* constants)
}

// TimeRange values accepted by Options.TimeRange. Empty means "any time."
const (
	TimeRangeAny   = ""
	TimeRangeDay   = "day"
	TimeRangeWeek  = "week"
	TimeRangeMonth = "month"
	TimeRangeYear  = "year"
)

// Client executes web searches on demand.
type Client interface {
	Search(ctx context.Context, query string, opts Options) ([]Result, error)
	// Provider returns the identifier of the underlying search provider for logging.
	Provider() string
	// Ping verifies the provider is reachable now. Any HTTP response counts
	// as up (even 4xx/5xx) — only network / DNS / TLS failures return err.
	Ping(ctx context.Context) error
}

// NewClient constructs the concrete client for the configured provider.
func NewClient(cfg Config) (Client, error) {
	timeout := cfg.HTTPTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	switch cfg.Provider {
	case ProviderSearXNG:
		c := &searxngClient{
			baseURL: cfg.BaseURL,
			http:    &http.Client{Timeout: timeout},
		}
		if gcp.IsRunAppURL(cfg.BaseURL) {
			c.idToken = gcp.NewFetcher(cfg.BaseURL)
		}
		return c, nil
	default:
		return nil, &ConfigError{Message: fmt.Sprintf("unsupported provider %q", cfg.Provider)}
	}
}
