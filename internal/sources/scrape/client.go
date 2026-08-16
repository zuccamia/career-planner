package scrape

// Package scrape wraps a web-scraping backend (Firecrawl hosted or Crawl4AI
// self-hosted) behind a single Go interface.
//
// The browser BYOK path does NOT use this client — it dispatches directly to
// the scraper from the frontend so the user's key never touches the server.
// See web/static/js/scrape-client.mjs.

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/zuccamia/career-planner/internal/gcp"
)

// Client fetches web content on demand. Implementations wrap a single backend.
type Client interface {
	// Scrape returns the URL rendered to markdown (and optionally HTML).
	Scrape(ctx context.Context, url string, opts ScrapeOptions) (*ScrapeResult, error)
	// Map returns URLs discovered on the domain of the given URL. Used for
	// ATS discovery today and jobs discovery later.
	Map(ctx context.Context, url string, opts ScrapeOptions) (*MapResult, error)
	// Provider returns the identifier of the underlying scraper provider
	// ("firecrawl" or "crawl4ai") for logging and cache keying.
	Provider() string
	// Ping verifies the provider is reachable now. Any HTTP response counts
	// as up (even 4xx/5xx) — only network / DNS / TLS failures return err.
	Ping(ctx context.Context) error
}

// Ping issues a HEAD to the configured baseURL. Shared by both providers —
// we care only whether the server accepts a connection, not the status.
func (b *httpBase) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, b.baseURL, nil)
	if err != nil {
		return err
	}
	if b.idToken != nil {
		if tok, err := b.idToken.Get(ctx); err == nil {
			req.Header.Set("X-Serverless-Authorization", "Bearer "+tok)
		}
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// NewClient constructs the concrete client for the configured backend.
func NewClient(cfg Config) (Client, error) {
	base := &httpBase{
		baseURL: cfg.BaseURL,
		apiKey:  cfg.APIKey,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
	// *.run.app targets: attach ID token in X-Serverless-Authorization so IAM
	// passes while Authorization stays free for the app-level token.
	if gcp.IsRunAppURL(cfg.BaseURL) {
		base.idToken = gcp.NewFetcher(cfg.BaseURL)
	}
	switch cfg.Provider {
	case ProviderFirecrawl:
		return &firecrawlClient{httpBase: base}, nil
	case ProviderCrawl4AI:
		return &crawl4aiClient{httpBase: base}, nil
	default:
		return nil, &ConfigError{Message: fmt.Sprintf("unsupported provider %q", cfg.Provider)}
	}
}

// httpBase carries HTTP concerns shared by both provider implementations.
type httpBase struct {
	baseURL string
	apiKey  string
	http    *http.Client
	// Non-nil for *.run.app targets; adds the IAM header on requests.
	idToken *gcp.Fetcher
}
