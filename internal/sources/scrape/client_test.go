package scrape

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFirecrawlScrape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scrape" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("missing bearer token, got %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		var got firecrawlScrapeReq
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if got.URL != "https://example.com" {
			t.Fatalf("unexpected url %s", got.URL)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(firecrawlScrapeResp{
			Success: true,
			Data: struct {
				Markdown string         `json:"markdown"`
				HTML     string         `json:"html"`
				Metadata map[string]any `json:"metadata"`
			}{Markdown: "# Hello", Metadata: map[string]any{"title": "Hi"}},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Backend: BackendFirecrawl, BaseURL: server.URL, APIKey: "test-key"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	res, err := client.Scrape(context.Background(), "https://example.com", ScrapeOptions{OnlyMainContent: true})
	if err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if res.Markdown != "# Hello" {
		t.Fatalf("markdown = %q", res.Markdown)
	}
	if res.Backend != BackendFirecrawl {
		t.Fatalf("backend = %s", res.Backend)
	}
}

func TestFirecrawlMap(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/map" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(firecrawlMapResp{
			Success: true,
			Links:   []string{"https://acme.com/careers", "https://boards.greenhouse.io/acme"},
		})
	}))
	defer server.Close()

	client, _ := NewClient(Config{Backend: BackendFirecrawl, BaseURL: server.URL, APIKey: "k"})
	res, err := client.Map(context.Background(), "https://acme.com", ScrapeOptions{})
	if err != nil {
		t.Fatalf("Map: %v", err)
	}
	if len(res.URLs) != 2 {
		t.Fatalf("got %d urls", len(res.URLs))
	}
}

func TestCrawl4AIScrape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/md" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(crawl4aiMDResp{
			Success:  true,
			URL:      "https://example.com",
			Markdown: "# Hi",
		})
	}))
	defer server.Close()

	client, _ := NewClient(Config{Backend: BackendCrawl4AI, BaseURL: server.URL})
	res, err := client.Scrape(context.Background(), "https://example.com", ScrapeOptions{})
	if err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if res.Markdown != "# Hi" {
		t.Fatalf("markdown = %q", res.Markdown)
	}
	if res.Backend != BackendCrawl4AI {
		t.Fatalf("backend = %s", res.Backend)
	}
}

func TestCrawl4AIMapExtractsSameDomainLinks(t *testing.T) {
	html := `<html><body>
		<a href="https://acme.com/careers">careers</a>
		<a href="/about">about</a>
		<a href="https://boards.greenhouse.io/acme">jobs</a>
		<a href="mailto:foo@acme.com">email</a>
		<a href="#section">anchor</a>
		<a href="javascript:void(0)">js</a>
	</body></html>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/html" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(crawl4aiHTMLResp{Success: true, HTML: html})
	}))
	defer server.Close()

	client, _ := NewClient(Config{Backend: BackendCrawl4AI, BaseURL: server.URL})
	res, err := client.Map(context.Background(), "https://acme.com", ScrapeOptions{})
	if err != nil {
		t.Fatalf("Map: %v", err)
	}
	want := map[string]bool{
		"https://acme.com/careers":          true,
		"https://acme.com/about":            true,
		"https://boards.greenhouse.io/acme": true,
	}
	if len(res.URLs) != len(want) {
		t.Fatalf("got %d urls, want %d: %v", len(res.URLs), len(want), res.URLs)
	}
	for _, u := range res.URLs {
		if !want[u] {
			t.Fatalf("unexpected url %s", u)
		}
	}
}

func TestAPIErrorOnNon2xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer server.Close()

	client, _ := NewClient(Config{Backend: BackendFirecrawl, BaseURL: server.URL, APIKey: "k"})
	_, err := client.Scrape(context.Background(), "https://example.com", ScrapeOptions{})
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Status != 500 {
		t.Fatalf("status = %d", apiErr.Status)
	}
}

func TestLoadConfigEmpty(t *testing.T) {
	t.Setenv("SCRAPER_BACKEND", "")
	t.Setenv("SCRAPER_BASE_URL", "")
	t.Setenv("SCRAPER_API_KEY", "")
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for empty config")
	}
	if _, ok := err.(*ConfigError); !ok {
		t.Fatalf("expected *ConfigError, got %T", err)
	}
}

func TestLoadConfigFirecrawlNeedsAPIKey(t *testing.T) {
	t.Setenv("SCRAPER_BACKEND", "firecrawl")
	t.Setenv("SCRAPER_BASE_URL", "")
	t.Setenv("SCRAPER_API_KEY", "")
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "SCRAPER_API_KEY") {
		t.Fatalf("expected mention of SCRAPER_API_KEY, got %v", err)
	}
}

func TestLoadConfigCrawl4AIOK(t *testing.T) {
	t.Setenv("SCRAPER_BACKEND", "crawl4ai")
	t.Setenv("SCRAPER_BASE_URL", "http://localhost:11235")
	t.Setenv("SCRAPER_API_KEY", "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Backend != BackendCrawl4AI {
		t.Fatalf("backend = %s", cfg.Backend)
	}
	if cfg.BaseURL != "http://localhost:11235" {
		t.Fatalf("base url = %s", cfg.BaseURL)
	}
}
