package scrape

// Package scrape wraps a web-scraping backend (Firecrawl hosted or Crawl4AI
// self-hosted) behind a single Go interface.
//
// The browser BYOK path does NOT use this client — it dispatches directly to
// the scraper from the frontend so the user's key never touches the server.
// See web/static/local/js/scrape-client.mjs.

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// Client fetches web content on demand. Implementations wrap a single backend.
type Client interface {
	// Scrape returns the URL rendered to markdown (and optionally HTML).
	Scrape(ctx context.Context, url string, opts ScrapeOptions) (*ScrapeResult, error)
	// Map returns URLs discovered on the domain of the given URL. Used for
	// ATS discovery today and jobs discovery later.
	Map(ctx context.Context, url string, opts ScrapeOptions) (*MapResult, error)
	// Backend returns the identifier of the underlying backend
	// ("firecrawl" or "crawl4ai") for logging and cache keying.
	Backend() string
}

// NewClient constructs the concrete client for the configured backend.
func NewClient(cfg Config) (Client, error) {
	base := &httpBase{
		baseURL: cfg.BaseURL,
		apiKey:  cfg.APIKey,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
	switch cfg.Backend {
	case BackendFirecrawl:
		return &firecrawlClient{httpBase: base}, nil
	case BackendCrawl4AI:
		return &crawl4aiClient{httpBase: base}, nil
	default:
		return nil, &ConfigError{Message: fmt.Sprintf("unsupported backend %q", cfg.Backend)}
	}
}

// httpBase carries HTTP concerns shared by both backend implementations.
type httpBase struct {
	baseURL string
	apiKey  string
	http    *http.Client
}
