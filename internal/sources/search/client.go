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
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/gcp"
	"github.com/zuccamia/career-planner/internal/util"
)

// ---- client ----

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

// ---- searxng ----

// SearXNG JSON API client. SearXNG exposes GET /search?format=json returning
// {results: [{url, title, content, engine}, ...]}. Instances typically require
// no auth — this client sends the query as a GET and parses the JSON envelope.

var publishedDateLayouts = []string{
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

type searxngClient struct {
	baseURL string
	http    *http.Client
	// Non-nil for *.run.app hosts; adds the Cloud Run IAM header on requests.
	idToken *gcp.Fetcher
}

func (c *searxngClient) attachIDToken(ctx context.Context, req *http.Request) {
	if c.idToken == nil {
		return
	}
	if tok, err := c.idToken.Get(ctx); err == nil {
		req.Header.Set("X-Serverless-Authorization", "Bearer "+tok)
	}
}

func (c *searxngClient) Provider() string { return ProviderSearXNG }

func (c *searxngClient) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, c.baseURL, nil)
	if err != nil {
		return err
	}
	// SearXNG's default limiter flags UA-less requests; match Search's header
	// so Ping sees the same acceptance policy the real query would.
	req.Header.Set("User-Agent", searxngUserAgent)
	c.attachIDToken(ctx, req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// searxngUserAgent is a browser-like UA needed to get past SearXNG's default
// limiter plugin, which returns 4xx HTML for anonymous / non-browser agents.
const searxngUserAgent = "Mozilla/5.0 (compatible; career-planner-discover/1.0)"

// searxngMaxResponseBytes caps the JSON body Search will read. Real SearXNG
// results are tens of KB; the cap is defense against a runaway response.
const searxngMaxResponseBytes = 2 << 20 // 2 MiB

// searxngErrorBodySnippetBytes bounds how much of a non-2xx body ends up in
// the error message so a huge HTML error page doesn't flood logs.
const searxngErrorBodySnippetBytes = 512

type searxngResponse struct {
	Results []struct {
		URL              string `json:"url"`
		Title            string `json:"title"`
		Content          string `json:"content"`
		Engine           string `json:"engine"`
		PublishedDate    string `json:"publishedDate"`
		PublishedDateAlt string `json:"published_date"`
	} `json:"results"`
}

func (c *searxngClient) Search(ctx context.Context, query string, opts Options) ([]Result, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, fmt.Errorf("search: query is empty")
	}
	params := url.Values{}
	params.Set("q", q)
	params.Set("format", "json")
	params.Set("safesearch", "1")
	// pageno=1 always. Page 2+ doubles the per-engine fanout for near-zero
	// improvement in careers-search precision.
	params.Set("pageno", "1")
	if len(opts.Categories) > 0 {
		params.Set("categories", strings.Join(opts.Categories, ","))
	}
	if opts.Language != "" {
		params.Set("language", opts.Language)
	}
	if len(opts.Engines) > 0 {
		params.Set("engines", strings.Join(opts.Engines, ","))
	}
	if opts.TimeRange != "" {
		params.Set("time_range", opts.TimeRange)
	}

	endpoint := c.baseURL + "/search?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("search: build request: %w", err)
	}
	// Some SearXNG instances refuse the JSON format for anonymous browsers;
	// setting Accept helps route past those defaults.
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", searxngUserAgent)
	c.attachIDToken(ctx, req)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("search: request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, searxngMaxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("search: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > searxngErrorBodySnippetBytes {
			snippet = snippet[:searxngErrorBodySnippetBytes] + "…"
		}
		return nil, fmt.Errorf("search: searxng returned %s: %s", resp.Status, snippet)
	}
	var parsed searxngResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("search: decode response: %w", err)
	}
	limit := opts.Limit
	if limit <= 0 || limit > len(parsed.Results) {
		limit = len(parsed.Results)
	}
	out := make([]Result, 0, limit)
	for _, r := range parsed.Results[:limit] {
		if strings.TrimSpace(r.URL) == "" {
			continue
		}
		out = append(out, Result{
			URL:         r.URL,
			Title:       r.Title,
			Content:     r.Content,
			Engine:      r.Engine,
			PublishedAt: util.ParseTimestamp(publishedDateLayouts, r.PublishedDate, r.PublishedDateAlt),
		})
	}
	return out, nil
}
