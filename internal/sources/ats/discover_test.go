package ats

import (
	"context"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

type fakeMapper struct {
	urls []string
	err  error
}

func (f *fakeMapper) Map(_ context.Context, url string, _ scrape.ScrapeOptions) (*scrape.MapResult, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &scrape.MapResult{Domain: url, URLs: f.urls}, nil
}

func TestDiscoverATSURL(t *testing.T) {
	tests := []struct {
		name     string
		urls     []string
		wantURL  string
		wantProv string
	}{
		{
			name:     "greenhouse boards",
			urls:     []string{"https://acme.com", "https://boards.greenhouse.io/acme"},
			wantURL:  "https://boards.greenhouse.io/acme",
			wantProv: "greenhouse",
		},
		{
			name:     "lever",
			urls:     []string{"https://jobs.lever.co/acme"},
			wantURL:  "https://jobs.lever.co/acme",
			wantProv: "lever",
		},
		{
			name:     "ashby",
			urls:     []string{"https://jobs.ashbyhq.com/acme"},
			wantURL:  "https://jobs.ashbyhq.com/acme",
			wantProv: "ashby",
		},
		{
			name:     "workday",
			urls:     []string{"https://acme.wd1.myworkdayjobs.com/en-US/acme"},
			wantURL:  "https://acme.wd1.myworkdayjobs.com/en-US/acme",
			wantProv: "workday",
		},
		{
			name:     "careers subdomain",
			urls:     []string{"https://acme.com", "https://careers.acme.com"},
			wantURL:  "https://careers.acme.com",
			wantProv: "careers-subdomain",
		},
		{
			name:     "greenhouse beats careers when both listed",
			urls:     []string{"https://careers.acme.com", "https://boards.greenhouse.io/acme"},
			wantURL:  "https://careers.acme.com", // first match wins; order is source-controlled
			wantProv: "careers-subdomain",
		},
		{
			name:    "no match",
			urls:    []string{"https://acme.com", "https://acme.com/about"},
			wantURL: "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, prov, err := DiscoverATSURL(context.Background(), &fakeMapper{urls: tt.urls}, "https://acme.com")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.wantURL {
				t.Errorf("url = %q, want %q", got, tt.wantURL)
			}
			if prov != tt.wantProv {
				t.Errorf("provider = %q, want %q", prov, tt.wantProv)
			}
		})
	}
}

func TestDiscoverATSURLRejectsUnsafeSchemes(t *testing.T) {
	// A malicious page could put javascript:/data:/mailto: URLs on a page whose
	// host happens to match one of our patterns. Filter them out before they
	// land on the company row.
	urls := []string{
		"javascript:alert('boards.greenhouse.io/acme')",
		"data:text/html,<script>",
		"mailto:jobs@boards.greenhouse.io",
		"//boards.greenhouse.io/acme", // scheme-relative, empty scheme
		"https://boards.greenhouse.io/acme",
	}
	got, prov, err := DiscoverATSURL(context.Background(), &fakeMapper{urls: urls}, "https://acme.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "https://boards.greenhouse.io/acme" {
		t.Fatalf("expected first safe url, got %q", got)
	}
	if prov != "greenhouse" {
		t.Fatalf("provider = %q", prov)
	}
}

func TestDiscoverATSURLNoMapperOrEmptyURL(t *testing.T) {
	if got, _, _ := DiscoverATSURL(context.Background(), nil, "https://acme.com"); got != "" {
		t.Errorf("expected empty result with nil mapper, got %q", got)
	}
	if got, _, _ := DiscoverATSURL(context.Background(), &fakeMapper{}, ""); got != "" {
		t.Errorf("expected empty result with empty url, got %q", got)
	}
}
