package ats_test

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/ats/providers"
)

func TestRegistryIsLandingPage(t *testing.T) {
	// Load real providers.json so hostPatterns() covers greenhouse/lever/ashby.
	_, thisFile, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")
	if err := ats.LoadProviders(filepath.Join(root, "web", "static", "data")); err != nil {
		t.Fatalf("LoadProviders: %v", err)
	}
	reg := ats.NewRegistry(providers.NewGeneric(), providers.NewGreenhouse(), providers.NewLever(), providers.NewAshby())

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
