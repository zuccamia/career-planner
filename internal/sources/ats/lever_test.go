package ats

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLeverSupports(t *testing.T) {
	l := NewLever()
	cases := map[string]bool{
		"https://jobs.lever.co/acme/abc-123":         true,
		"https://jobs.lever.co/acme/abc-123/apply":   true,
		"https://jobs.lever.co/acme":                 false,
		"https://boards.greenhouse.io/acme/jobs/123": false,
		"not a url":                                  false,
	}
	for in, want := range cases {
		if got := l.Supports(in); got != want {
			t.Errorf("Supports(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestLeverFetch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/postings/acme/abc-123" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("mode") != "json" {
			t.Errorf("expected mode=json, got %q", r.URL.Query().Get("mode"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"text": "Backend Engineer",
			"hostedUrl": "https://jobs.lever.co/acme/abc-123",
			"description": "<p>Join our team.</p>",
			"lists": [{"text": "Responsibilities", "content": "<ul><li>Ship code</li></ul>"}],
			"additional": "<p>Perks.</p>",
			"categories": {"team": "Platform", "department": "Engineering", "location": "New York", "commitment": "Full-time"}
		}`))
	}))
	defer server.Close()

	l := &Lever{client: server.Client(), apiBase: server.URL}
	got, err := l.Fetch(context.Background(), "https://jobs.lever.co/acme/abc-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "lever" || got.Title != "Backend Engineer" {
		t.Errorf("unexpected posting: %+v", got)
	}
	if got.Location != "New York" || got.Department != "Engineering" || got.Team != "Platform" {
		t.Errorf("unexpected categories: %+v", got)
	}
	if got.EmploymentType != "Full-time" {
		t.Errorf("EmploymentType = %q, want raw Lever commitment %q", got.EmploymentType, "Full-time")
	}
	if !strings.Contains(got.DescriptionText, "Join our team") ||
		!strings.Contains(got.DescriptionText, "Ship code") ||
		!strings.Contains(got.DescriptionText, "Perks") {
		t.Errorf("description missing sections: %q", got.DescriptionText)
	}
}

func TestLeverFetch404(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	defer server.Close()

	l := &Lever{client: server.Client(), apiBase: server.URL}
	_, err := l.Fetch(context.Background(), "https://jobs.lever.co/acme/deleted")
	// discover.extractPostings uses errors.Is(err, ErrPostingNotFound) to
	// drop dead-link URLs before they reach the ranker. Assert on the
	// sentinel, not the error string.
	if !errors.Is(err, ErrPostingNotFound) {
		t.Fatalf("expected ErrPostingNotFound, got %v", err)
	}
}
