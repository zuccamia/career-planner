package http

// Regression tests that pin the enrichment behavior of the two dossier-build
// paths side-by-side. A prior bug shipped where the server-LLM handler
// (/api/dossiers/build) ran scrape + ATS-discovery on the server, but the
// BYOK-LLM handler (/api/llm/prompts/build-dossier) only assembled the
// prompt — so BYOK-LLM users on a deploy with SCRAPER_* set never got any
// scraping done. These tests assert both handlers exercise s.scrape when
// the caller hasn't pre-supplied content / an ATS URL.

import (
	"context"
	"encoding/json"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

// fakeScraper counts calls to Scrape and Map so tests can assert whether the
// handler exercised each. Returns benign responses so best-effort code paths
// don't take an error branch. Safe for concurrent use — scrapeMissingIntoEnrichment
// fans out with a WaitGroup.
type fakeScraper struct {
	scrapeCalls atomic.Int32
	mapCalls    atomic.Int32
	// mapURLs, if non-empty, drives DiscoverATSURL by returning URLs the
	// ATS host regex matches (see ats.atsHostPatterns).
	mapURLs []string
}

func (f *fakeScraper) Backend() string { return "fake" }

func (f *fakeScraper) Scrape(_ context.Context, url string, _ scrape.ScrapeOptions) (*scrape.ScrapeResult, error) {
	f.scrapeCalls.Add(1)
	return &scrape.ScrapeResult{URL: url, Markdown: "scraped:" + url, Backend: "fake", FetchedAt: time.Now()}, nil
}

func (f *fakeScraper) Map(_ context.Context, url string, _ scrape.ScrapeOptions) (*scrape.MapResult, error) {
	f.mapCalls.Add(1)
	return &scrape.MapResult{Domain: url, URLs: f.mapURLs, Backend: "fake", FetchedAt: time.Now()}, nil
}

// serverWithScraper wires a fake scrape.Client into a nilServer so both the
// server-LLM and BYOK handlers see the same s.scrape field.
func serverWithScraper(f *fakeScraper) *Server {
	s := nilServer()
	s.scrape = f
	return s
}

// ---------- BYOK build-dossier (regression for the shipped gap) ----------

func TestBYOKBuildDossierScrapesWhenBrowserDidNotPrescrape(t *testing.T) {
	f := &fakeScraper{}
	s := serverWithScraper(f)
	mux := newBYOKMux(s)
	// website provided but no *_content fields → server should scrape.
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/build-dossier",
		`{"official_name":"Acme","website":"https://acme.example","ats_url":"https://boards.greenhouse.io/acme"}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if got := f.scrapeCalls.Load(); got == 0 {
		t.Fatalf("expected s.scrape.Scrape to be called for missing WebsiteContent; got 0 calls")
	}
	var body struct{ System, User string }
	decodeBody(t, rr, &body)
	if !strings.Contains(body.User, "scraped:https://acme.example") {
		t.Errorf("scraped content should be folded into prompt; user=%q", body.User)
	}
}

func TestBYOKBuildDossierSkipsScrapeWhenBrowserPrescraped(t *testing.T) {
	f := &fakeScraper{}
	s := serverWithScraper(f)
	mux := newBYOKMux(s)
	// All three *_content fields non-empty → server must NOT re-scrape.
	body := map[string]any{
		"official_name":   "Acme",
		"website":         "https://acme.example",
		"blog_url":        "https://acme.example/blog",
		"ats_url":         "https://boards.greenhouse.io/acme",
		"website_content": "prescraped-website",
		"blog_content":    "prescraped-blog",
		"careers_content": "prescraped-careers",
	}
	raw, _ := json.Marshal(body)
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/build-dossier", string(raw))
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if got := f.scrapeCalls.Load(); got != 0 {
		t.Errorf("expected no server-side scrapes when browser pre-supplied all content; got %d", got)
	}
}

func TestBYOKBuildDossierDiscoversATSWhenMissing(t *testing.T) {
	// Map returns a URL matching ats.atsHostPatterns → DiscoverATSURL picks it.
	f := &fakeScraper{mapURLs: []string{"https://boards.greenhouse.io/acme"}}
	s := serverWithScraper(f)
	mux := newBYOKMux(s)
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/build-dossier",
		`{"official_name":"Acme","website":"https://acme.example","website_content":"prescraped"}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if got := f.mapCalls.Load(); got == 0 {
		t.Fatalf("expected s.scrape.Map to be called for ATS discovery; got 0 calls")
	}
	var body struct{ System, User string }
	decodeBody(t, rr, &body)
	// Discovered URL should be folded into the assembled prompt.
	if !strings.Contains(body.User, "boards.greenhouse.io/acme") {
		t.Errorf("discovered ATS URL should appear in prompt; user=%q", body.User)
	}
}

func TestBYOKBuildDossierSkipsATSDiscoveryWhenSupplied(t *testing.T) {
	f := &fakeScraper{}
	s := serverWithScraper(f)
	mux := newBYOKMux(s)
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/build-dossier",
		`{"official_name":"Acme","website":"https://acme.example","ats_url":"https://boards.greenhouse.io/acme","website_content":"prescraped","careers_content":"prescraped"}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if got := f.mapCalls.Load(); got != 0 {
		t.Errorf("expected no ATS discovery when ats_url supplied; got %d Map calls", got)
	}
}

// ---------- Server-LLM build-dossier (symmetry check) ----------

// The server-LLM handler already had scrape + ATS discovery. This test locks
// that behavior in so the two paths stay symmetric.
func TestRPCBuildDossierScrapesAndDiscoversWhenMissing(t *testing.T) {
	f := &fakeScraper{mapURLs: []string{"https://boards.greenhouse.io/acme"}}
	s := serverWithScraper(f)
	// Server-LLM path also calls s.dossiers.BuildText which needs a client.
	// A nil client returns an error; the handler returns 500 but Scrape/Map
	// are called before BuildText. So we still assert the calls here even if
	// the final HTTP status is 500 — the enrichment step ran.
	req := httptest.NewRequest("POST", "/", strings.NewReader(
		`{"official_name":"Acme","website":"https://acme.example"}`))
	rr := httptest.NewRecorder()
	s.rpcBuildDossier(rr, req)
	if got := f.scrapeCalls.Load(); got == 0 {
		t.Errorf("expected s.scrape.Scrape to be called on server-LLM path; got 0 calls")
	}
	if got := f.mapCalls.Load(); got == 0 {
		t.Errorf("expected s.scrape.Map to be called on server-LLM path; got 0 calls")
	}
}
