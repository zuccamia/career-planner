package ats

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGreenhouseSupports(t *testing.T) {
	g := NewGreenhouse()
	cases := map[string]bool{
		"https://boards.greenhouse.io/acme/jobs/123":       true,
		"https://job-boards.greenhouse.io/acme/jobs/123":   true,
		"https://boards.greenhouse.io/acme/jobs/":          false,
		"https://boards.greenhouse.io/acme":                false,
		"https://boards.greenhouse.io/acme/departments/1":  false,
		"https://jobs.lever.co/acme/abc-123":               false,
		"not a url":                                        false,
	}
	for in, want := range cases {
		if got := g.Supports(in); got != want {
			t.Errorf("Supports(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestGreenhouseFetch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/boards/acme/jobs/123" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"title": "Software Engineer",
			"company_name": "Acme Inc.",
			"absolute_url": "https://boards.greenhouse.io/acme/jobs/123",
			"content": "&lt;p&gt;Build things at &lt;strong&gt;Acme&lt;/strong&gt;.&lt;/p&gt;",
			"location": {"name": "Remote - US"},
			"departments": [{"name": "Engineering"}, {"name": "Platform"}]
		}`))
	}))
	defer server.Close()

	g := &Greenhouse{client: server.Client(), apiBase: server.URL}
	got, err := g.Fetch(context.Background(), "https://boards.greenhouse.io/acme/jobs/123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "greenhouse" {
		t.Errorf("Provider = %q, want greenhouse", got.Provider)
	}
	if got.Title != "Software Engineer" {
		t.Errorf("Title = %q", got.Title)
	}
	if got.Company != "Acme Inc." {
		t.Errorf("Company = %q", got.Company)
	}
	if got.Location != "Remote - US" {
		t.Errorf("Location = %q", got.Location)
	}
	if got.Department != "Engineering" {
		t.Errorf("Department = %q, want first department", got.Department)
	}
	if !strings.Contains(got.DescriptionText, "Build things at Acme") {
		t.Errorf("DescriptionText = %q, want unescaped HTML text", got.DescriptionText)
	}
}

func TestGreenhouseFetch404(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	defer server.Close()

	g := &Greenhouse{client: server.Client(), apiBase: server.URL}
	_, err := g.Fetch(context.Background(), "https://boards.greenhouse.io/acme/jobs/999")
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected not-found error, got %v", err)
	}
}
