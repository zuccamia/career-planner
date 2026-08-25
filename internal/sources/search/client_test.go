package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/zuccamia/career-planner/internal/gcp"
)

func TestSearXNGSearch(t *testing.T) {
	var got url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		got = r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"results": [
				{"url":"https://boards.greenhouse.io/foo/jobs/1","title":"Backend Engineer","content":"Snippet","engine":"duckduckgo","publishedDate":"2026-08-07T10:20:30Z"},
				{"url":"https://jobs.lever.co/bar/2","title":"SRE","content":"Snippet2","engine":"google","published_date":"2026-08-06"},
				{"url":"","title":"Should be skipped"}
			]
		}`))
	}))
	defer srv.Close()

	client, err := NewClient(Config{Provider: ProviderSearXNG, BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	results, err := client.Search(context.Background(), "acme careers", Options{
		Limit:      5,
		Categories: []string{"general"},
		Language:   "en",
		Engines:    []string{"google", "bing"},
		TimeRange:  "day",
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if got.Get("q") != "acme careers" || got.Get("format") != "json" {
		t.Errorf("q/format: %+v", got)
	}
	if got.Get("categories") != "general" || got.Get("language") != "en" {
		t.Errorf("categories/language: %+v", got)
	}
	if got.Get("engines") != "google,bing" {
		t.Errorf("engines: %q", got.Get("engines"))
	}
	if got.Get("time_range") != "day" {
		t.Errorf("time_range: %q", got.Get("time_range"))
	}
	if got.Get("pageno") != "1" {
		t.Errorf("pageno: %q", got.Get("pageno"))
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results (empty URL skipped), got %d", len(results))
	}
	if results[0].URL != "https://boards.greenhouse.io/foo/jobs/1" || results[0].Title != "Backend Engineer" {
		t.Errorf("unexpected first result: %+v", results[0])
	}
	if results[1].Engine != "google" {
		t.Errorf("unexpected engine on second result: %q", results[1].Engine)
	}
	if got, want := results[0].PublishedAt, time.Date(2026, 8, 7, 10, 20, 30, 0, time.UTC); !got.Equal(want) {
		t.Errorf("first PublishedAt = %v, want %v", got, want)
	}
	if got, want := results[1].PublishedAt, time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Errorf("second PublishedAt = %v, want %v", got, want)
	}
}

func TestSearXNGSearchOmitsZeroValueOptions(t *testing.T) {
	var got url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()
	client, _ := NewClient(Config{Provider: ProviderSearXNG, BaseURL: srv.URL})
	_, err := client.Search(context.Background(), "x", Options{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	for _, name := range []string{"engines", "time_range", "categories", "language"} {
		if got.Has(name) {
			t.Errorf("expected %q param omitted when Options field is zero-value, got %q", name, got.Get(name))
		}
	}
	// pageno always sent, always 1.
	if got.Get("pageno") != "1" {
		t.Errorf("pageno should always be sent as 1, got %q", got.Get("pageno"))
	}
}

func TestSearXNGSearchError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	client, err := NewClient(Config{Provider: ProviderSearXNG, BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := client.Search(context.Background(), "x", Options{}); err == nil {
		t.Fatal("expected error on 500 response")
	}
}

func TestLoadConfig(t *testing.T) {
	t.Setenv("SEARCH_BACKEND", "")
	t.Setenv("SEARCH_BASE_URL", "")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("expected ConfigError when SEARCH_BASE_URL is unset")
	}
	t.Setenv("SEARCH_BASE_URL", "https://searxng.example.com/")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.BaseURL != "https://searxng.example.com" {
		t.Errorf("expected trailing slash trimmed, got %q", cfg.BaseURL)
	}
	if cfg.Provider != ProviderSearXNG {
		t.Errorf("expected backend %q, got %q", ProviderSearXNG, cfg.Provider)
	}
	t.Setenv("SEARCH_BACKEND", "wat")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("expected ConfigError on unsupported backend")
	}
}

func TestSearchEmptyQuery(t *testing.T) {
	client, err := NewClient(Config{Provider: ProviderSearXNG, BaseURL: "http://ignored"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := client.Search(context.Background(), "   ", Options{}); err == nil {
		t.Fatal("expected error for empty query")
	}
}

// TestSearXNGSearchSetsUserAgent guards the SearXNG-limiter workaround: the
// client must send a browser-like UA so the default limiter doesn't 4xx us.
func TestSearXNGSearchSetsUserAgent(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()

	client, _ := NewClient(Config{Provider: ProviderSearXNG, BaseURL: srv.URL})
	if _, err := client.Search(context.Background(), "x", Options{}); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if gotUA != searxngUserAgent {
		t.Errorf("User-Agent = %q, want %q", gotUA, searxngUserAgent)
	}
}

// TestSearXNGPing verifies Ping treats any HTTP response as up and sends the
// same UA as Search (so the limiter policy is consistent).
func TestSearXNGPing(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client, _ := NewClient(Config{Provider: ProviderSearXNG, BaseURL: srv.URL})
	if err := client.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	if gotUA != searxngUserAgent {
		t.Errorf("Ping User-Agent = %q, want %q", gotUA, searxngUserAgent)
	}
}

// TestSearXNGSearchErrorSnippetTruncated: non-2xx bodies larger than the
// snippet cap are truncated with an ellipsis so noisy HTML error pages don't
// bloat logs.
func TestSearXNGSearchErrorSnippetTruncated(t *testing.T) {
	huge := strings.Repeat("A", searxngErrorBodySnippetBytes+200)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(huge))
	}))
	defer srv.Close()

	client, _ := NewClient(Config{Provider: ProviderSearXNG, BaseURL: srv.URL})
	_, err := client.Search(context.Background(), "x", Options{})
	if err == nil {
		t.Fatal("expected error on 500 response")
	}
	msg := err.Error()
	if !strings.Contains(msg, "…") {
		t.Errorf("expected ellipsis marker in truncated error, got: %s", msg)
	}
	// The truncated snippet plus the "search: searxng returned 500 ..." wrapper
	// must be well below the raw body size.
	if len(msg) > searxngErrorBodySnippetBytes+200 {
		t.Errorf("error message %d bytes; expected truncation to keep it near %d", len(msg), searxngErrorBodySnippetBytes)
	}
}

// Private Cloud Run SearXNG: Search attaches the ID token in
// X-Serverless-Authorization, and repeated calls reuse the cached token.
func TestSearXNGSendsServerlessAuthOnCloudRun(t *testing.T) {
	var metadataHits int
	metadataServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		metadataHits++
		_, _ = writer.Write([]byte("test-id-token"))
	}))
	defer metadataServer.Close()

	originalMetadataURL := gcp.MetadataIdentityURL
	gcp.MetadataIdentityURL = metadataServer.URL + "/instance/service-accounts/default/identity"
	defer func() { gcp.MetadataIdentityURL = originalMetadataURL }()

	searxngServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("X-Serverless-Authorization"); got != "Bearer test-id-token" {
			t.Errorf("X-Serverless-Authorization = %q, want Bearer test-id-token", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"results":[]}`))
	}))
	defer searxngServer.Close()

	// httptest gives a 127.0.0.1 URL, so IsRunAppURL is false — attach the
	// fetcher directly with a real *.run.app audience.
	client := &searxngClient{
		baseURL: searxngServer.URL,
		http:    &http.Client{Timeout: 5 * time.Second},
		idToken: gcp.NewFetcher("https://searxng-demo-xyz.run.app"),
	}
	if _, err := client.Search(context.Background(), "q", Options{}); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if _, err := client.Search(context.Background(), "q", Options{}); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if metadataHits != 1 {
		t.Errorf("metadata hits = %d, want 1 (cache broken)", metadataHits)
	}
}

func TestSearXNGSkipsServerlessAuthOffCloudRun(t *testing.T) {
	searxngServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("X-Serverless-Authorization"); got != "" {
			t.Errorf("X-Serverless-Authorization = %q, want empty", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"results":[]}`))
	}))
	defer searxngServer.Close()

	client, err := NewClient(Config{Provider: ProviderSearXNG, BaseURL: searxngServer.URL})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	searxng, ok := client.(*searxngClient)
	if !ok {
		t.Fatalf("expected *searxngClient")
	}
	if searxng.idToken != nil {
		t.Fatalf("idToken should be nil for non–Cloud-Run URL")
	}
	if _, err := client.Search(context.Background(), "q", Options{}); err != nil {
		t.Fatalf("Search: %v", err)
	}
}
