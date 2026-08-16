package http

// Shared test setup and helpers for the http package. Loads prompt JSON and
// ATS provider config once for the whole package, provides service/server
// stubs and a fake scrape.Client for handler tests.

import (
	"context"
	"log"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/dossiers"
	"github.com/zuccamia/career-planner/internal/i18n/testutil"
	"github.com/zuccamia/career-planner/internal/profile"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

func init() {
	testutil.MustLoadPrompts()
	_, thisFile, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	if err := ats.LoadProviders(filepath.Join(root, "web", "static", "data")); err != nil {
		log.Fatalf("ats.LoadProviders: %v", err)
	}
}

// nilServer returns a Server whose services carry nil LLM clients. Fine for
// handler tests that don't exercise the LLM client field itself.
func nilServer() *Server {
	return &Server{
		companies:      companies.NewService(nil),
		dossiers:       dossiers.NewService(nil),
		applications:   applications.NewService(nil, nil, nil, nil),
		brags:          brags.NewService(nil),
		communications: communications.NewService(nil),
		profile:        profile.NewService(nil),
	}
}

// fakeScraper counts calls to Scrape and Map so tests can assert whether the
// handler exercised each. Safe for concurrent use.
type fakeScraper struct {
	scrapeCalls atomic.Int32
	mapCalls    atomic.Int32
	// mapURLs, if non-empty, drives LookupATSURL by returning URLs the
	// ATS host regex matches.
	mapURLs []string
}

func (f *fakeScraper) Provider() string            { return "fake" }
func (f *fakeScraper) Ping(context.Context) error { return nil }

func (f *fakeScraper) Scrape(_ context.Context, url string, _ scrape.ScrapeOptions) (*scrape.ScrapeResult, error) {
	f.scrapeCalls.Add(1)
	return &scrape.ScrapeResult{URL: url, Markdown: "scraped:" + url, Provider: "fake", FetchedAt: time.Now()}, nil
}

func (f *fakeScraper) Map(_ context.Context, url string, _ scrape.ScrapeOptions) (*scrape.MapResult, error) {
	f.mapCalls.Add(1)
	return &scrape.MapResult{Domain: url, URLs: f.mapURLs, Provider: "fake", FetchedAt: time.Now()}, nil
}

// serverWithScraper wires a fake scrape.Client into a nilServer. Handler
// capability checks succeed because s.scrape is non-nil and the fake's Ping
// returns nil.
func serverWithScraper(f *fakeScraper) *Server {
	s := nilServer()
	s.scrape = f
	return s
}
