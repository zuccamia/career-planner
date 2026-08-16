package ats

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"testing"
)

type stubProvider struct {
	name     string
	supports func(string) bool
	posting  Posting
	err      error
}

func (s *stubProvider) Name() string                { return s.name }
func (s *stubProvider) Supports(rawURL string) bool { return s.supports(rawURL) }
func (s *stubProvider) Fetch(_ context.Context, _ string) (Posting, error) {
	return s.posting, s.err
}

func TestRegistryPicksFirstSupportingProvider(t *testing.T) {
	greenhouse := &stubProvider{
		name:     "greenhouse",
		supports: func(u string) bool { return u == "https://gh.example/job" },
		posting:  Posting{Provider: "greenhouse", Title: "Engineer"},
	}
	lever := &stubProvider{
		name:     "lever",
		supports: func(u string) bool { return u == "https://lever.example/job" },
		posting:  Posting{Provider: "lever"},
	}
	fallback := &stubProvider{
		name:     "generic",
		supports: func(string) bool { return true },
		posting:  Posting{Provider: "generic"},
	}
	reg := NewRegistry(fallback, greenhouse, lever)

	got, err := reg.Fetch(context.Background(), "https://gh.example/job")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "greenhouse" || got.Title != "Engineer" {
		t.Errorf("got %+v, want greenhouse", got)
	}
}

func TestRegistryFallsBackWhenNoneSupport(t *testing.T) {
	fallback := &stubProvider{
		name:     "generic",
		supports: func(string) bool { return true },
		posting:  Posting{Provider: "generic", DescriptionText: "body"},
	}
	reg := NewRegistry(fallback)

	got, err := reg.Fetch(context.Background(), "https://unknown.example/x")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "generic" || got.DescriptionText != "body" {
		t.Errorf("got %+v, want generic fallback", got)
	}
}

func TestRegistryErrorsWhenNoFallbackAndNoMatch(t *testing.T) {
	reg := NewRegistry(nil)
	_, err := reg.Fetch(context.Background(), "https://x")
	if err == nil {
		t.Fatal("expected error when no fallback and no match")
	}
}

func TestRegistryIsLandingPage(t *testing.T) {
	// Load real providers.json so hostPatterns() covers greenhouse/lever/ashby.
	_, thisFile, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")
	if err := LoadProviders(filepath.Join(root, "web", "static", "data")); err != nil {
		t.Fatalf("LoadProviders: %v", err)
	}
	reg := NewRegistry(NewGeneric(), NewGreenhouse(), NewLever(), NewAshby())

	cases := map[string]struct {
		url  string
		want bool
	}{
		"greenhouse landing (host recognized, no /jobs/id)":    {"https://boards.greenhouse.io/acme", true},
		"greenhouse specific (host recognized + parses)":       {"https://boards.greenhouse.io/acme/jobs/123", false},
		"job-boards greenhouse landing":                        {"https://job-boards.greenhouse.io/acme", true},
		"lever landing":                                        {"https://jobs.lever.co/acme", true},
		"lever specific":                                       {"https://jobs.lever.co/acme/abc-123", false},
		"ashby landing":                                        {"https://jobs.ashbyhq.com/acme", true},
		"non-ATS host (workable — no structured parser):":      {"https://apply.workable.com/co/j/xyz", false},
		"totally unrelated host":                               {"https://example.com/careers", false},

		// Slug-in-path segment-count branch: fires for registered hosts that
		// don't have a structured extractor in the registry under test. Real
		// posting shapes carry ≥2 non-empty path segments; landing shapes
		// (tenant-only, or post-redirect ?not_found=true) carry <2.
		"workable landing (tenant only)":                       {"https://apply.workable.com/acme", true},
		"workable landing (trailing slash)":                    {"https://apply.workable.com/acme/", true},
		"workable landing (post-redirect not_found)":           {"https://apply.workable.com/acme/?not_found=true", true},
		"workable posting shape (three path segments)":         {"https://apply.workable.com/acme/j/CODE", false},
		"smartrecruiters landing":                              {"https://jobs.smartrecruiters.com/acme", true},
		"smartrecruiters specific posting":                     {"https://jobs.smartrecruiters.com/acme/7440-role-slug", false},
	}
	for name, tc := range cases {
		if got := reg.IsLandingPage(tc.url); got != tc.want {
			t.Errorf("%s: IsLandingPage(%q) = %v, want %v", name, tc.url, got, tc.want)
		}
	}
}

func TestRegistryPropagatesProviderError(t *testing.T) {
	boom := errors.New("upstream down")
	fallback := &stubProvider{
		name:     "generic",
		supports: func(string) bool { return true },
		err:      boom,
	}
	reg := NewRegistry(fallback)
	_, err := reg.Fetch(context.Background(), "https://x.example/job")
	if !errors.Is(err, boom) {
		t.Fatalf("got %v, want %v", err, boom)
	}
}
