package scrape

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsCloudRunURL(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"https://scraper-demo-123.us-central1.run.app", true},
		{"https://career-planner-ecuctbkvkq-uc.a.run.app", true},
		// case + trailing slash + port artifacts
		{"https://SCRAPER.RUN.APP/", true},
		{"https://foo.run.app:443/path", true},
		// non–Cloud-Run
		{"https://api.firecrawl.dev", false},
		{"http://localhost:11235", false},
		{"https://scraper.mycompany.com", false},
		// look-alikes that should NOT match
		{"https://run.app.evil.com", false},
		{"https://myrunapp.com", false},
		// malformed
		{"", false},
		{"::not a url::", false},
	}
	for _, c := range cases {
		if got := isCloudRunURL(c.in); got != c.want {
			t.Errorf("isCloudRunURL(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestFirecrawlSendsServerlessAuthOnCloudRun spins up two servers: one plays
// the role of the Cloud Run scraper and asserts it received *both* auth
// headers, and one plays the metadata server that mints the ID token.
func TestFirecrawlSendsServerlessAuthOnCloudRun(t *testing.T) {
	// Fake metadata server: responds with a canned token when queried for
	// the audience the scraper client should ask for.
	var metaHits int
	metaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Metadata-Flavor") != "Google" {
			t.Errorf("missing Metadata-Flavor header on ID-token fetch")
		}
		metaHits++
		w.Write([]byte("test-id-token"))
	}))
	defer metaServer.Close()

	// Point the fetcher at our fake metadata server for the duration of this
	// test. Suffix stays "/instance/service-accounts/default/identity" to
	// match real usage.
	orig := metadataIdentityURL
	metadataIdentityURL = metaServer.URL + "/instance/service-accounts/default/identity"
	defer func() { metadataIdentityURL = orig }()

	// Fake scraper: asserts both headers landed. Success response so the
	// firecrawl client returns cleanly.
	scraper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer app-token" {
			t.Errorf("Authorization = %q, want Bearer app-token", got)
		}
		if got := r.Header.Get("X-Serverless-Authorization"); got != "Bearer test-id-token" {
			t.Errorf("X-Serverless-Authorization = %q, want Bearer test-id-token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(firecrawlScrapeResp{Success: true})
	}))
	defer scraper.Close()

	// httptest gives us a 127.0.0.1 URL, so isCloudRunURL is false — force
	// the ID-token path directly for the test.
	client := &firecrawlClient{httpBase: &httpBase{
		baseURL: scraper.URL,
		apiKey:  "app-token",
		http:    &http.Client{},
		idToken: newIDTokenFetcher("https://scraper-demo-xyz.run.app"),
	}}
	if _, err := client.Scrape(context.Background(), "https://example.com", ScrapeOptions{}); err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if metaHits != 1 {
		t.Errorf("metadata server hit %d times, want 1", metaHits)
	}

	// Second call reuses the cached token (no new metadata hit).
	if _, err := client.Scrape(context.Background(), "https://example.com", ScrapeOptions{}); err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if metaHits != 1 {
		t.Errorf("metadata server hit %d times after 2 scrapes, want 1 (cache broken)", metaHits)
	}
}

func TestFirecrawlSkipsServerlessAuthOffCloudRun(t *testing.T) {
	// Same fake scraper; asserts X-Serverless-Authorization is absent when
	// no idToken fetcher was attached (the default for non-run.app URLs).
	scraper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Serverless-Authorization"); got != "" {
			t.Errorf("X-Serverless-Authorization = %q, want empty for non-Cloud-Run target", got)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(firecrawlScrapeResp{Success: true})
	}))
	defer scraper.Close()

	// NewClient with a non-run.app URL should leave idToken nil.
	c, err := NewClient(Config{Backend: BackendFirecrawl, BaseURL: scraper.URL, APIKey: "app-token"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	fc, ok := c.(*firecrawlClient)
	if !ok {
		t.Fatalf("expected *firecrawlClient")
	}
	if fc.idToken != nil {
		t.Fatalf("idToken should be nil for non-run.app URL")
	}
	if _, err := c.Scrape(context.Background(), "https://example.com", ScrapeOptions{}); err != nil {
		t.Fatalf("Scrape: %v", err)
	}
}

// TestIDTokenFetcherFailsFastOffGCP guards the local-dev path: when the
// metadata server is unreachable, get() should return an error quickly so
// the caller can drop the header and let the request proceed. We simulate
// unreachability by pointing at a closed server.
func TestIDTokenFetcherFailsFastOffGCP(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	stub.Close() // immediately close so connections are refused

	orig := metadataIdentityURL
	metadataIdentityURL = stub.URL + "/instance/service-accounts/default/identity"
	defer func() { metadataIdentityURL = orig }()

	f := newIDTokenFetcher("https://x.run.app")
	if _, err := f.get(context.Background()); err == nil {
		t.Fatalf("expected error when metadata server is unreachable")
	} else if !strings.Contains(err.Error(), "connect") && !strings.Contains(err.Error(), "refused") {
		// Different OS/Go versions phrase the error slightly differently.
		// We just want to confirm it errored — content is informational.
		t.Logf("got error (fine): %v", err)
	}
}
