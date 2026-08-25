package scrape

// Package scrape wraps a web-scraping backend (Firecrawl hosted or Crawl4AI
// self-hosted) behind a single Go interface.
//
// The browser BYOK path does NOT use this client — it dispatches directly to
// the scraper from the frontend so the user's key never touches the server.
// See web/static/js/scrape-client.mjs.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/gcp"
)

// ---- client ----

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

// ---- firecrawl ----

// Firecrawl v1 API client. Docs: https://docs.firecrawl.dev/api-reference/
// This is a thin wrapper — we only use /v1/scrape and /v1/map.

type firecrawlClient struct {
	*httpBase
}

func (c *firecrawlClient) Provider() string { return ProviderFirecrawl }

type firecrawlScrapeReq struct {
	URL             string   `json:"url"`
	Formats         []string `json:"formats,omitempty"`
	OnlyMainContent bool     `json:"onlyMainContent,omitempty"`
	WaitFor         int      `json:"waitFor,omitempty"`
}

type firecrawlScrapeResp struct {
	Success bool `json:"success"`
	Data    struct {
		Markdown string         `json:"markdown"`
		HTML     string         `json:"html"`
		Metadata map[string]any `json:"metadata"`
	} `json:"data"`
	Error string `json:"error"`
}

func (c *firecrawlClient) Scrape(ctx context.Context, url string, opts ScrapeOptions) (*ScrapeResult, error) {
	formats := opts.Formats
	if len(formats) == 0 {
		formats = []string{"markdown"}
	}
	body := firecrawlScrapeReq{
		URL:             url,
		Formats:         formats,
		OnlyMainContent: opts.OnlyMainContent,
		WaitFor:         opts.WaitFor,
	}
	var resp firecrawlScrapeResp
	if err := c.postJSON(ctx, "/v1/scrape", body, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("firecrawl scrape: %s", resp.Error)}
	}
	return &ScrapeResult{
		URL:       url,
		Markdown:  resp.Data.Markdown,
		HTML:      resp.Data.HTML,
		Metadata:  resp.Data.Metadata,
		Provider: ProviderFirecrawl,
		FetchedAt: time.Now().UTC(),
	}, nil
}

type firecrawlMapReq struct {
	URL string `json:"url"`
}

type firecrawlMapResp struct {
	Success bool     `json:"success"`
	Links   []string `json:"links"`
	Error   string   `json:"error"`
}

func (c *firecrawlClient) Map(ctx context.Context, url string, opts ScrapeOptions) (*MapResult, error) {
	body := firecrawlMapReq{URL: url}
	var resp firecrawlMapResp
	if err := c.postJSON(ctx, "/v1/map", body, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("firecrawl map: %s", resp.Error)}
	}
	return &MapResult{
		Domain:    url,
		URLs:      resp.Links,
		Provider: ProviderFirecrawl,
		FetchedAt: time.Now().UTC(),
	}, nil
}

func (b *httpBase) postJSON(ctx context.Context, path string, requestBody any, out any) error {
	payload, err := json.Marshal(requestBody)
	if err != nil {
		return &Error{Message: fmt.Sprintf("marshal request: %v", err)}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return &Error{Message: fmt.Sprintf("build request: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	if b.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+b.apiKey)
	}
	// Cloud Run IAM header; off-GCP the fetch errors and we send the request
	// without it, which is right for public / self-hosted scrapers.
	if b.idToken != nil {
		if tok, err := b.idToken.Get(ctx); err == nil {
			req.Header.Set("X-Serverless-Authorization", "Bearer "+tok)
		}
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("request failed: %v", err)}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("read response: %v", err)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{
			Status:  resp.StatusCode,
			Message: fmt.Sprintf("scraper API returned %s: %s", resp.Status, strings.TrimSpace(string(body))),
		}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &APIError{Message: fmt.Sprintf("decode response: %v", err)}
	}
	return nil
}

// ---- crawl4ai ----

// Crawl4AI docker server client. Endpoints: docs.crawl4ai.com/core/self-hosting
// (v0.9.x, mid-2026). Uses POST /md for scrape and POST /html + client-side
// link extraction to synthesize Map (Crawl4AI has no native map endpoint).

type crawl4aiClient struct {
	*httpBase
}

func (c *crawl4aiClient) Provider() string { return ProviderCrawl4AI }

type crawl4aiMDReq struct {
	URL string `json:"url"`
}

type crawl4aiMDResp struct {
	Success  bool           `json:"success"`
	URL      string         `json:"url"`
	Markdown string         `json:"markdown"`
	Metadata map[string]any `json:"metadata"`
	Error    string         `json:"error"`
}

func (c *crawl4aiClient) Scrape(ctx context.Context, u string, _ ScrapeOptions) (*ScrapeResult, error) {
	var resp crawl4aiMDResp
	if err := c.postJSON(ctx, "/md", crawl4aiMDReq{URL: u}, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("crawl4ai md: %s", resp.Error)}
	}
	return &ScrapeResult{
		URL:       u,
		Markdown:  resp.Markdown,
		Metadata:  resp.Metadata,
		Provider: ProviderCrawl4AI,
		FetchedAt: time.Now().UTC(),
	}, nil
}

type crawl4aiHTMLReq struct {
	URL string `json:"url"`
}

type crawl4aiHTMLResp struct {
	Success bool   `json:"success"`
	URL     string `json:"url"`
	HTML    string `json:"html"`
	Error   string `json:"error"`
}

var hrefRE = regexp.MustCompile(`(?i)href\s*=\s*["']([^"']+)["']`)

func (c *crawl4aiClient) Map(ctx context.Context, u string, _ ScrapeOptions) (*MapResult, error) {
	var resp crawl4aiHTMLResp
	if err := c.postJSON(ctx, "/html", crawl4aiHTMLReq{URL: u}, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("crawl4ai html: %s", resp.Error)}
	}

	base, err := url.Parse(u)
	if err != nil {
		return nil, &Error{Message: fmt.Sprintf("parse base url: %v", err)}
	}

	seen := make(map[string]struct{})
	urls := make([]string, 0, 32)
	for _, m := range hrefRE.FindAllStringSubmatch(resp.HTML, -1) {
		raw := strings.TrimSpace(m[1])
		if raw == "" || strings.HasPrefix(raw, "#") || strings.HasPrefix(raw, "javascript:") ||
			strings.HasPrefix(raw, "mailto:") || strings.HasPrefix(raw, "tel:") {
			continue
		}
		abs, err := base.Parse(raw)
		if err != nil {
			continue
		}
		abs.Fragment = ""
		s := abs.String()
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		urls = append(urls, s)
	}

	return &MapResult{
		Domain:    u,
		URLs:      urls,
		Provider: ProviderCrawl4AI,
		FetchedAt: time.Now().UTC(),
	}, nil
}
