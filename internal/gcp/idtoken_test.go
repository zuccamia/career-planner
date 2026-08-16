package gcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsRunAppURL(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"https://scraper-demo-123.us-central1.run.app", true},
		{"https://career-planner-ecuctbkvkq-uc.a.run.app", true},
		{"https://SCRAPER.RUN.APP/", true},
		{"https://foo.run.app:443/path", true},
		{"https://api.firecrawl.dev", false},
		{"http://localhost:11235", false},
		{"https://scraper.mycompany.com", false},
		{"https://run.app.evil.com", false},
		{"https://myrunapp.com", false},
		{"", false},
		{"::not a url::", false},
	}
	for _, c := range cases {
		if got := IsRunAppURL(c.in); got != c.want {
			t.Errorf("IsRunAppURL(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestFetcherCachesToken(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Metadata-Flavor") != "Google" {
			t.Errorf("missing Metadata-Flavor header")
		}
		hits++
		w.Write([]byte("test-id-token"))
	}))
	defer srv.Close()

	orig := MetadataIdentityURL
	MetadataIdentityURL = srv.URL + "/instance/service-accounts/default/identity"
	defer func() { MetadataIdentityURL = orig }()

	f := NewFetcher("https://svc.run.app")
	for i := 0; i < 3; i++ {
		tok, err := f.Get(context.Background())
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if tok != "test-id-token" {
			t.Fatalf("token = %q, want test-id-token", tok)
		}
	}
	if hits != 1 {
		t.Errorf("metadata hits = %d, want 1 (cache broken)", hits)
	}
}

func TestFetcherFailsFastOffGCP(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	stub.Close()

	orig := MetadataIdentityURL
	MetadataIdentityURL = stub.URL + "/instance/service-accounts/default/identity"
	defer func() { MetadataIdentityURL = orig }()

	if _, err := NewFetcher("https://x.run.app").Get(context.Background()); err == nil {
		t.Fatalf("expected error when metadata server is unreachable")
	} else if !strings.Contains(err.Error(), "connect") && !strings.Contains(err.Error(), "refused") {
		t.Logf("got error (fine): %v", err)
	}
}
