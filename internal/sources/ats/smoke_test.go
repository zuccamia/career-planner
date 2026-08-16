//go:build smoke
// +build smoke

package ats

// Nightly smoke tests — one live URL per structured extractor. Not part of the
// default suite; opt in with `go test -tags=smoke ./internal/sources/ats/...`
// (the CI workflow at .github/workflows/nightly-smoke.yml does this on cron).
//
// When a URL 404s, that's the drift signal: either the anchor posting was
// filled/removed (update the URL) or the provider changed their API/URL scheme
// (fix the parser). Prefer big-brand stable tenants so fixtures survive.

import (
	"context"
	"strings"
	"testing"
	"time"
)

type smokeTarget struct {
	name     string
	provider interface {
		Supports(string) bool
		Fetch(context.Context, string) (Posting, error)
	}
	url string
}

// smokeTargets holds one currently-live posting URL per registered extractor.
// The exact URLs will go stale — updating them is the maintenance task the
// nightly workflow surfaces.
var smokeTargets = []smokeTarget{
	{"greenhouse", NewGreenhouse(),      "https://job-boards.greenhouse.io/anthropic/jobs/5101378008"},
	{"lever",      NewLever(),           "https://jobs.lever.co/matchgroup/3414ba28-35f7-45d3-8e13-35c883959635"},
	{"ashby",      NewAshby(),           "https://jobs.ashbyhq.com/openai/7af121a1-d29a-4745-84c1-ef1b58a3b840"},
	{"eightfold",  NewEightfold(),       "https://bostonscientific.eightfold.ai/careers/job/563602811481461-r-d-software-engineer-intern-arden-hills-us-mn-united-states-n-a?domain=bostonscientific.com"},
	{"smartrec",   NewSmartRecruiters(), "https://jobs.smartrecruiters.com/DeliveryHero/744000143698619-associate-commercial-groceries-instashop"},
	{"workable",   NewWorkable(),        "https://apply.workable.com/trycaddi/j/9D1291C697"},
}

func TestExtractorSmoke(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for _, tc := range smokeTargets {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if !tc.provider.Supports(tc.url) {
				t.Fatalf("URL fixture no longer matches provider — update smoke_test.go: %s", tc.url)
			}
			p, err := tc.provider.Fetch(ctx, tc.url)
			if err != nil {
				t.Fatalf("Fetch failed (likely URL 404 or API drift): %v", err)
			}
			if strings.TrimSpace(p.Title) == "" {
				t.Error("empty Title — likely response-shape drift")
			}
			if strings.TrimSpace(p.Company) == "" {
				t.Error("empty Company — likely response-shape drift or missing tenant→name mapping")
			}
			if strings.TrimSpace(p.DescriptionText) == "" {
				t.Error("empty DescriptionText — likely response-shape drift")
			}
			t.Logf("%s: title=%q company=%q desc_len=%d", tc.name, p.Title, p.Company, len(p.DescriptionText))
		})
	}
}
