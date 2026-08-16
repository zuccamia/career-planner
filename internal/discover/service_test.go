package discover

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
	"github.com/zuccamia/career-planner/internal/sources/search"
)

// loadPromptsForTest points the LLM prompt loader + ATS provider loader
// at the repo's real static dirs so tests can exercise the real config.
// Also disables the network-based dead-link check so canned test URLs
// don't get dropped for 404-ing against the real internet.
func loadPromptsForTest(t *testing.T) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	if err := llm.LoadPrompts(filepath.Join(root, "web", "static", "i18n", "prompts")); err != nil {
		t.Fatalf("LoadPrompts: %v", err)
	}
	if err := ats.LoadProviders(filepath.Join(root, "web", "static", "data")); err != nil {
		t.Fatalf("LoadProviders: %v", err)
	}
	httpStatusProbe = func(context.Context, *http.Client, string) (bool, string) { return false, "" }
	t.Cleanup(func() { httpStatusProbe = probeHTTPStatus })
}

// --- fakes ---

type fakeLLM struct {
	variants    []string
	signals     []string
	expandErr   error
	recs        []Recommendation
	rankErr     error
	expandCalls int
	rankCalls   int
	calls       []llm.Prompt
	mu          sync.Mutex
}

func (f *fakeLLM) GenerateJSON(_ context.Context, p llm.Prompt, out any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, p)
	sys := strings.ToLower(p.System)
	switch {
	case strings.Contains(sys, "job-discovery assistant"):
		f.expandCalls++
		if f.expandErr != nil {
			return f.expandErr
		}
		return jsonInto(out, map[string]any{
			"role_variants":   f.variants,
			"signal_keywords": f.signals,
		})
	case strings.Contains(sys, "job-match ranker"):
		f.rankCalls++
		if f.rankErr != nil {
			return f.rankErr
		}
		return jsonInto(out, map[string]any{"recommendations": f.recs})
	}
	return errors.New("fakeLLM: unrecognized prompt")
}

func jsonInto(out any, v any) error {
	blob, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(blob, out)
}

// fakeSearch routes queries to canned results by substring match on q.
// Suggested key convention: `site:<host>` returns hits for that host.
type fakeSearch struct {
	byQuery map[string][]search.Result
	err     error
	mu      sync.Mutex
	calls   int
	queries []string
}

func (f *fakeSearch) Provider() string              { return "fake" }
func (f *fakeSearch) Ping(context.Context) error   { return nil }
func (f *fakeSearch) Search(_ context.Context, q string, _ search.Options) ([]search.Result, error) {
	f.mu.Lock()
	f.calls++
	f.queries = append(f.queries, q)
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	for k, v := range f.byQuery {
		if strings.Contains(q, k) {
			return v, nil
		}
	}
	return nil, nil
}

type fakeATS struct {
	supports        map[string]bool
	landing         map[string]bool
	resolvesLanding map[string]bool
	posting         ats.Posting
	err             error
}

func (f *fakeATS) HasSupportingProvider(u string) bool                       { return f.supports[u] }
func (f *fakeATS) IsLandingPage(u string) bool                               { return f.landing[u] }
func (f *fakeATS) ResolvesToLandingPage(_ context.Context, u string) bool    { return f.resolvesLanding[u] }
func (f *fakeATS) Fetch(_ context.Context, u string) (ats.Posting, error) {
	if f.err != nil {
		return ats.Posting{}, f.err
	}
	p := f.posting
	if p.ApplyURL == "" {
		p.ApplyURL = u
	}
	return p, nil
}

// nilScrape is the "no scraper configured" placeholder. Both methods error
// so a test path that mistakenly hits it fails loudly.
type nilScrape struct{}

func (nilScrape) Scrape(context.Context, string, scrape.ScrapeOptions) (*scrape.ScrapeResult, error) {
	return nil, errors.New("not used")
}
func (nilScrape) Map(context.Context, string, scrape.ScrapeOptions) (*scrape.MapResult, error) {
	return nil, errors.New("not used")
}
func (nilScrape) Provider() string                { return "nil" }
func (nilScrape) Ping(context.Context) error     { return nil }

// --- tests ---

func TestServiceRun_HappyPath(t *testing.T) {
	loadPromptsForTest(t)

	acmeURL := "https://boards.greenhouse.io/acme/jobs/1234"
	globexURL := "https://jobs.lever.co/globex/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	llmFake := &fakeLLM{
		variants: []string{"Backend Engineer", "Software Engineer, Backend"},
		signals:  []string{"fintech", "payments"},
		recs: []Recommendation{
			{Title: "Backend Engineer", Company: "Acme", URL: acmeURL, MatchScore: 90, Rationale: "strong fit"},
			{Title: "Backend Engineer", Company: "Globex", URL: globexURL, MatchScore: 80, Rationale: "good fit"},
		},
	}
	// Site-scoped searches route by `site:<host>` substring — one canned
	// result set per ATS host we search.
	searchFake := &fakeSearch{byQuery: map[string][]search.Result{
		"site:boards.greenhouse.io": {{URL: acmeURL, Title: "Backend Engineer at Acme", Content: "Snippet"}},
		"site:jobs.lever.co":        {{URL: globexURL, Title: "Backend Engineer at Globex", Content: "Snippet"}},
	}}
	atsFake := &fakeATS{
		supports: map[string]bool{acmeURL: true},
		posting:  ats.Posting{Title: "Backend Engineer", Company: "Acme", Provider: "greenhouse"},
	}

	svc := NewService(llmFake, searchFake, nilScrape{}, atsFake)
	if svc == nil {
		t.Fatal("service should not be nil with all deps set")
	}
	resp, err := svc.Run(context.Background(), DiscoverRequest{
		Profile: ProfileSummary{Headline: "Backend Engineer", Summary: "10y Go", Skills: []string{"go", "postgres"}},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(resp.Recommendations) != 2 {
		t.Fatalf("expected 2 recs, got %d (%v)", len(resp.Recommendations), resp.Recommendations)
	}
	if llmFake.rankCalls != 1 {
		t.Errorf("expected exactly one rank LLM call, got %d", llmFake.rankCalls)
	}
	// Provider + BoardURL should flow through to Recommendations.
	for _, r := range resp.Recommendations {
		if r.Provider == "" {
			t.Errorf("expected provider populated on rec %+v", r)
		}
		if r.BoardURL == "" {
			t.Errorf("expected board_url populated on rec %+v", r)
		}
	}
}

func TestServiceRun_EmptyHeadline(t *testing.T) {
	loadPromptsForTest(t)
	llmFake := &fakeLLM{}
	svc := NewService(llmFake, &fakeSearch{}, nilScrape{}, &fakeATS{})
	resp, err := svc.Run(context.Background(), DiscoverRequest{
		Profile: ProfileSummary{Headline: ""},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(resp.Recommendations) != 0 {
		t.Errorf("expected no recs, got %d", len(resp.Recommendations))
	}
	if len(resp.Diagnostics) == 0 {
		t.Error("expected a diagnostic explaining empty-headline short-circuit")
	}
	if llmFake.expandCalls != 0 {
		t.Errorf("empty headline must skip LLM expand; got %d calls", llmFake.expandCalls)
	}
}

func TestServiceRun_EmptyRoleVariantsFallsBackToHeadline(t *testing.T) {
	loadPromptsForTest(t)
	// LLM returns no role_variants — the pipeline must fall back to the raw
	// headline so search still runs.
	url := "https://boards.greenhouse.io/acme/jobs/1"
	llmFake := &fakeLLM{
		variants: nil,
		recs:     []Recommendation{{Title: "Backend Engineer", Company: "Acme", URL: url, MatchScore: 80}},
	}
	searchFake := &fakeSearch{byQuery: map[string][]search.Result{
		"site:boards.greenhouse.io": {{URL: url, Title: "Backend Engineer at Acme"}},
	}}
	atsFake := &fakeATS{
		supports: map[string]bool{url: true},
		posting:  ats.Posting{Title: "Backend Engineer", Company: "Acme", Provider: "greenhouse"},
	}
	svc := NewService(llmFake, searchFake, nilScrape{}, atsFake)
	resp, err := svc.Run(context.Background(), DiscoverRequest{
		Profile: ProfileSummary{Headline: "Backend Engineer"},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(resp.Recommendations) != 1 {
		t.Errorf("expected 1 rec via headline-fallback, got %d", len(resp.Recommendations))
	}
	// The headline should have been quoted into the query.
	found := false
	for _, q := range searchFake.queries {
		if strings.Contains(q, `"Backend Engineer"`) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected headline to appear as a quoted term in some query; got queries=%v", searchFake.queries)
	}
}

func TestServiceRun_NoHitsAcrossHosts(t *testing.T) {
	loadPromptsForTest(t)
	// LLM returns valid signals but no host returns any results.
	llmFake := &fakeLLM{variants: []string{"Backend Engineer"}}
	searchFake := &fakeSearch{byQuery: map[string][]search.Result{}}
	svc := NewService(llmFake, searchFake, nilScrape{}, &fakeATS{})
	resp, err := svc.Run(context.Background(), DiscoverRequest{
		Profile: ProfileSummary{Headline: "Backend Engineer"},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(resp.Recommendations) != 0 {
		t.Errorf("expected no recs, got %d", len(resp.Recommendations))
	}
	if len(resp.Diagnostics) == 0 {
		t.Error("expected diagnostic when no hits surface")
	}
}

func TestServiceRun_AllURLsAlreadyApplied(t *testing.T) {
	loadPromptsForTest(t)
	url := "https://boards.greenhouse.io/acme/jobs/1"
	llmFake := &fakeLLM{variants: []string{"Backend Engineer"}}
	searchFake := &fakeSearch{byQuery: map[string][]search.Result{
		"site:boards.greenhouse.io": {{URL: url, Title: "BE"}},
	}}
	atsFake := &fakeATS{
		supports: map[string]bool{url: true},
		posting:  ats.Posting{Title: "Backend Engineer", Company: "Acme", Provider: "greenhouse", ApplyURL: url},
	}
	svc := NewService(llmFake, searchFake, nilScrape{}, atsFake)
	resp, err := svc.Run(context.Background(), DiscoverRequest{
		Profile:      ProfileSummary{Headline: "Backend Engineer"},
		Applications: []ExistingApplication{{JobURL: url + "?utm_source=x"}},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(resp.Recommendations) != 0 {
		t.Errorf("expected no recs (all filtered), got %d", len(resp.Recommendations))
	}
	if len(resp.Diagnostics) == 0 {
		t.Error("expected diagnostic explaining URL filter")
	}
}

func TestServiceRun_LLMError(t *testing.T) {
	loadPromptsForTest(t)
	llmFake := &fakeLLM{expandErr: errors.New("llm down")}
	svc := NewService(llmFake, &fakeSearch{}, nilScrape{}, &fakeATS{})
	_, err := svc.Run(context.Background(), DiscoverRequest{
		Profile: ProfileSummary{Headline: "Backend Engineer"},
	})
	if err == nil {
		t.Fatal("expected error when expand LLM fails")
	}
}

func TestNewService_Capability(t *testing.T) {
	cases := []struct {
		name   string
		llm    llm.Client
		search search.Client
		scrape scrape.Client
		canRun bool
	}{
		{"nil llm", nil, &fakeSearch{}, nilScrape{}, false},
		{"nil search", &fakeLLM{}, nil, nilScrape{}, false},
		{"nil scrape only", &fakeLLM{}, &fakeSearch{}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewService(tc.llm, tc.search, tc.scrape, &fakeATS{})
			if svc == nil {
				t.Fatal("NewService returned nil; expected non-nil in all cases")
			}
			if got := svc.CanRunServerPipeline(); got != tc.canRun {
				t.Errorf("CanRunServerPipeline = %v, want %v", got, tc.canRun)
			}
		})
	}
}

func TestIsPastCycle(t *testing.T) {
	// Freeze "now" at Aug 15, 2026 → targetHireYear = 2027.
	restore := nowLocal
	nowLocal = func() time.Time { return time.Date(2026, time.August, 15, 0, 0, 0, 0, time.Local) }
	defer func() { nowLocal = restore }()

	cases := map[string]bool{
		// Past cycle in URL slug → drop.
		"https://startup.jobs/software-engineer-intern-summer-2026-theziphq-7863909": true,
		"https://startup.jobs/winter-2025-2026-something":                             true,
		"https://startup.jobs/fall-2024-role":                                         true,
		// Past cycle mentioned only in title → drop.
		"Software Engineer Intern (Summer 2026)":  true,
		"Backend Intern - Winter 2025":            true,
		// URL job ID + title carrying the cycle → drop via title.
		"https://boards.greenhouse.io/acme/jobs/7863909 Software Engineer Intern (Summer 2026)": true,
		// Target-year or later → keep.
		"https://startup.jobs/summer-2027-intern":                                    false,
		"Software Engineer Intern (Summer 2027)":                                     false,
		// No isolated year → keep.
		"https://boards.greenhouse.io/acme/jobs/7863909": false,
		"https://example.com/careers":                    false,
		"":                                               false,
		// Internal digits like 20264HR must not false-match as a year.
		"https://x.com/jobs/20264HR": false,
	}
	for in, want := range cases {
		if got := isPastCycle(in); got != want {
			t.Errorf("isPastCycle(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestNormalizeURL(t *testing.T) {
	cases := map[string]string{
		"":          "",
		"not a url": "not a url",
		// Registrable-domain host: subdomain collapses so tenant-frontend
		// variants (greenhouse's boards vs job-boards) dedupe together.
		"HTTPS://Boards.Greenhouse.io/Acme/jobs/1/":    "https://greenhouse.io/Acme/jobs/1",
		"https://job-boards.greenhouse.io/Acme/jobs/1": "https://greenhouse.io/Acme/jobs/1",
		// Deep subdomains — only last two labels survive.
		"https://a.b.c.example.com/x": "https://example.com/x",
		// Single-label / IPv4 hosts pass through.
		"http://localhost/path": "http://localhost/path",
		"http://192.168.1.1/x":  "http://1.1/x",
		// Query dropped wholesale — every job board identifies postings
		// via path, so any query is tracking (utm_*, gh_jid, ref, etc.).
		"https://x.com/a?utm_source=z&keep=1":                                        "https://x.com/a",
		"https://boards.greenhouse.io/figma/jobs/6131089004?gh_jid=6131089004":       "https://greenhouse.io/figma/jobs/6131089004",
		"https://boards.greenhouse.io/figma/jobs/6131089004":                          "https://greenhouse.io/figma/jobs/6131089004",
	}
	for in, want := range cases {
		if got := normalizeURL(in); got != want {
			t.Errorf("normalizeURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRankPostings_DropsUnknownURLs(t *testing.T) {
	loadPromptsForTest(t)
	realURL := "https://boards.greenhouse.io/acme/jobs/1"
	postedAt := time.Date(2026, 8, 7, 10, 20, 30, 0, time.UTC)
	llmFake := &fakeLLM{
		recs: []Recommendation{
			{Title: "Backend Engineer", Company: "Acme", URL: realURL, MatchScore: 90},
			{Title: "Attacker Bait", Company: "Phishy", URL: "https://phishy.example/job", MatchScore: 99, Rationale: "trust me"},
		},
	}
	svc := &Service{llm: llmFake}
	got, err := svc.rankPostings(context.Background(), DiscoverRequest{}, []JobPosting{
		{Title: "Backend Engineer", URL: realURL, Company: "Acme", Provider: "greenhouse", BoardURL: "https://boards.greenhouse.io/acme", PostedAt: &postedAt},
	}, 5)
	if err != nil {
		t.Fatalf("rankPostings: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 rec (hallucination dropped), got %d: %+v", len(got), got)
	}
	if got[0].URL != realURL {
		t.Errorf("unexpected URL survived: %+v", got[0])
	}
	if got[0].Provider != "greenhouse" || got[0].BoardURL != "https://boards.greenhouse.io/acme" {
		t.Errorf("Provider/BoardURL should be copied from origin posting: %+v", got[0])
	}
	if !got[0].PostedAt.Equal(postedAt) {
		t.Errorf("PostedAt should be copied from origin posting: got %v want %v", got[0].PostedAt, postedAt)
	}
}

func TestRankPostings_CapsSnippetTitle(t *testing.T) {
	loadPromptsForTest(t)
	longTitle := strings.Repeat("t", capPostingTitle+50)
	longSnippet := strings.Repeat("s", capPostingSnippet+200)
	llmFake := &fakeLLM{}
	svc := &Service{llm: llmFake}
	_, _ = svc.rankPostings(context.Background(), DiscoverRequest{}, []JobPosting{
		{Title: longTitle, URL: "https://x/1", Snippet: longSnippet, Company: "Co"},
	}, 5)
	if len(llmFake.calls) == 0 {
		t.Fatal("expected rank LLM to be called")
	}
	rankPrompt := llmFake.calls[len(llmFake.calls)-1]
	if strings.Contains(rankPrompt.User, longTitle) {
		t.Errorf("full-length title leaked into rank prompt")
	}
	if strings.Contains(rankPrompt.User, longSnippet) {
		t.Errorf("full-length snippet leaked into rank prompt")
	}
}

func TestExtractPostings_DropsSupportingHostFailures(t *testing.T) {
	// Any error on a host with a supporting extractor (Greenhouse/Lever/Ashby)
	// is treated as gone. Live postings on these hosts always yield a title;
	// non-404 errors (missing JSON-LD, rate limits, format drift) indicate the
	// posting is removed or malformed. Falling back to the search snippet
	// would just manufacture a bogus recommendation from cached copy.
	hits := []SearchHit{
		{URL: "https://jobs.lever.co/co/1", Title: "Original", BoardURL: "https://jobs.lever.co/co", Provider: "lever"},
	}
	atsFake := &fakeATS{
		supports: map[string]bool{"https://jobs.lever.co/co/1": true},
		err:      errors.New("boom"),
	}
	got, dead := extractPostings(context.Background(), hits, atsFake, newGoneCache(), 5)
	if len(got) != 0 {
		t.Fatalf("expected 0 postings (supporting-host failure dropped), got %d: %+v", len(got), got)
	}
	if dead != 1 {
		t.Errorf("expected dead=1, got %d", dead)
	}
}

func TestExtractPostings_DropsSupportingHostEmptyTitle(t *testing.T) {
	// Empty-title 200s from a supporting extractor also count as gone —
	// live postings always carry a title.
	hits := []SearchHit{
		{URL: "https://jobs.ashbyhq.com/co/1", Title: "Search title", BoardURL: "https://jobs.ashbyhq.com/co", Provider: "ashby"},
	}
	atsFake := &fakeATS{
		supports: map[string]bool{"https://jobs.ashbyhq.com/co/1": true},
		posting:  ats.Posting{Title: ""},
	}
	got, dead := extractPostings(context.Background(), hits, atsFake, newGoneCache(), 5)
	if len(got) != 0 {
		t.Fatalf("expected 0 postings (empty title dropped), got %d: %+v", len(got), got)
	}
	if dead != 1 {
		t.Errorf("expected dead=1, got %d", dead)
	}
}

func TestExtractPostings_DropsPostingNotFound(t *testing.T) {
	hits := []SearchHit{
		{URL: "https://jobs.lever.co/co/1", Title: "Gone", BoardURL: "https://jobs.lever.co/co", Provider: "lever"},
	}
	atsFake := &fakeATS{
		supports: map[string]bool{"https://jobs.lever.co/co/1": true},
		err:      fmt.Errorf("lever: %w: https://jobs.lever.co/co/1", ats.ErrPostingNotFound),
	}
	// Also verify the URL gets added to the process-lifetime cache — the
	// pre-filter on the next Run must be able to skip it before extract.
	gone := newGoneCache()
	got, dead := extractPostings(context.Background(), hits, atsFake, gone, 5)
	if len(got) != 0 {
		t.Fatalf("expected 0 postings (definitely-gone URL dropped), got %d: %+v", len(got), got)
	}
	if dead != 1 {
		t.Errorf("expected dead=1 (the 404 posting), got %d", dead)
	}
	if !gone.Has("https://jobs.lever.co/co/1") {
		t.Error("ErrPostingNotFound URL should be recorded in goneCache")
	}
}

func TestPreFilterHits_ThreeDropCategories(t *testing.T) {
	tracked := "https://boards.greenhouse.io/co/jobs/tracked"
	landing := "https://boards.greenhouse.io/co-landing"
	goneURL := "https://boards.greenhouse.io/co/jobs/gone"
	fresh := "https://boards.greenhouse.io/co/jobs/fresh"
	hits := []SearchHit{
		{URL: tracked}, {URL: landing}, {URL: goneURL}, {URL: fresh},
	}
	existing := map[string]struct{}{normalizeURL(tracked): {}}
	atsFake := &fakeATS{landing: map[string]bool{landing: true}}
	gone := newGoneCache()
	gone.Add(goneURL)

	kept, counts := preFilterHits(hits, existing, atsFake, gone)
	if len(kept) != 1 || kept[0].URL != fresh {
		t.Fatalf("expected only %q to survive, got %+v", fresh, kept)
	}
	if counts.dedupe != 1 || counts.shape != 1 || counts.goneCached != 1 {
		t.Errorf("expected dedupe=shape=goneCached=1, got %+v", counts)
	}
}

func TestGoneCache_EvictsHalfWhenFull(t *testing.T) {
	c := newGoneCache()
	for i := 0; i < goneCacheCap+50; i++ {
		c.Add(fmt.Sprintf("https://example.com/jobs/%d", i))
	}
	// Oldest 50%+eviction batch should be gone; the tail entries stay.
	if c.Has("https://example.com/jobs/0") {
		t.Error("oldest entry should have been evicted after cap breach")
	}
	last := fmt.Sprintf("https://example.com/jobs/%d", goneCacheCap+49)
	if !c.Has(last) {
		t.Errorf("most recent entry %q should still be in cache", last)
	}
}

func TestExtractPostings_PrefersATSPostedAtOverSearchPublishedAt(t *testing.T) {
	atsPostedAt := time.Date(2026, 8, 8, 15, 0, 0, 0, time.UTC)
	searchPublishedAt := time.Date(2026, 8, 7, 0, 0, 0, 0, time.UTC)
	hits := []SearchHit{{
		URL: "https://jobs.lever.co/co/1", Title: "Original",
		BoardURL: "https://jobs.lever.co/co", Provider: "lever", PublishedAt: searchPublishedAt,
	}}
	atsFake := &fakeATS{
		supports: map[string]bool{"https://jobs.lever.co/co/1": true},
		posting:  ats.Posting{Title: "Backend Engineer", Provider: "lever", ApplyURL: "https://jobs.lever.co/co/1", PostedAt: atsPostedAt},
	}
	got, _ := extractPostings(context.Background(), hits, atsFake, newGoneCache(), 5)
	if len(got) != 1 {
		t.Fatalf("expected 1 posting, got %d", len(got))
	}
	if !got[0].PostedAt.Equal(atsPostedAt) {
		t.Errorf("expected ATS PostedAt to win: got %v want %v", got[0].PostedAt, atsPostedAt)
	}
}

func TestNormalizeRequest_TruncatesAndTrims(t *testing.T) {
	big := strings.Repeat("x", capSummary+500)
	req := DiscoverRequest{
		Profile: ProfileSummary{
			Headline: "  hello  ",
			Summary:  big,
			Skills:   []string{"  go  ", "", strings.Repeat("y", capSkillName+50)},
		},
		Companies:    []SeedCompany{{Name: "  Acme  "}},
		Applications: []ExistingApplication{{JobURL: "  https://x/  "}},
		BragTitles:   []string{"  a  ", "", strings.Repeat("b", capBragTitle+10)},
		CareerSparks: []string{"  spark  ", strings.Repeat("c", capCareerSpark+10)},
	}
	got := normalizeRequest(req)

	if got.Profile.Headline != "hello" {
		t.Errorf("headline: got %q", got.Profile.Headline)
	}
	if len(got.Profile.Summary) != capSummary {
		t.Errorf("summary length: got %d want %d", len(got.Profile.Summary), capSummary)
	}
	if len(got.Profile.Skills) != 2 {
		t.Fatalf("skills: got %v", got.Profile.Skills)
	}
	if got.Profile.Skills[0] != "go" {
		t.Errorf("skills[0]: got %q", got.Profile.Skills[0])
	}
	if len(got.Profile.Skills[1]) != capSkillName {
		t.Errorf("skills[1] length: got %d want %d", len(got.Profile.Skills[1]), capSkillName)
	}
	if got.Companies[0].Name != "Acme" {
		t.Errorf("company name: got %q", got.Companies[0].Name)
	}
	if got.Applications[0].JobURL != "https://x/" {
		t.Errorf("job url: got %q", got.Applications[0].JobURL)
	}
	if len(got.BragTitles) != 2 {
		t.Fatalf("brag titles: got %v", got.BragTitles)
	}
	if len(got.CareerSparks) != 2 {
		t.Fatalf("sparks: got %v", got.CareerSparks)
	}
}

func TestNormalizeRequest_CollectionCaps(t *testing.T) {
	skills := make([]string, capSkills+10)
	for i := range skills {
		skills[i] = "s"
	}
	brags := make([]string, capBragTitles+10)
	for i := range brags {
		brags[i] = "b"
	}
	got := normalizeRequest(DiscoverRequest{
		Profile:    ProfileSummary{Skills: skills},
		BragTitles: brags,
	})
	if len(got.Profile.Skills) != capSkills {
		t.Errorf("skills cap: got %d want %d", len(got.Profile.Skills), capSkills)
	}
	if len(got.BragTitles) != capBragTitles {
		t.Errorf("brag titles cap: got %d want %d", len(got.BragTitles), capBragTitles)
	}
}
