package http

// Assembles the HTTP server, route table, and service dependencies.

import (
	"context"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/discover"
	"github.com/zuccamia/career-planner/internal/dossiers"
	"github.com/zuccamia/career-planner/internal/profile"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
	"github.com/zuccamia/career-planner/internal/sources/search"
)

// Server bundles the services needed by remaining HTTP handlers. All are
// stateless LLM helpers — the browser owns persistence.
type Server struct {
	companies      *companies.Service
	applications   *applications.Service
	brags          *brags.Service
	communications *communications.Service
	dossiers       *dossiers.Service
	profile        *profile.Service

	// Discovery service. Always non-nil; CanRunServerPipeline reports whether
	// the full server-side pipeline (LLM + search) is usable. The Dashboard
	// polls /api/discover/server-status to grey the Discover button when it
	// isn't.
	discover *discover.Service

	// Optional server-side scraper. Non-nil only when SCRAPER_* env vars are
	// configured. Used by rpcBuildDossier to enrich the LLM prompt with
	// scraped website markdown, and by the ATS registry as the generic
	// fallback fetcher. Never used on the browser BYOK path — browsers call
	// the scraper directly.
	scrape     scrape.Client
	scrapePing pingCache

	// Search client — the discover pipeline holds its own reference; this
	// one drives GET /api/search/server-status and /discover/server-status.
	search     search.Client
	searchPing pingCache

	// Cached view of the LLM_* env vars this process was started with. Read
	// via GET /api/llm/server-status so the browser can pick between the
	// "Server · <model>" and "AI: setup needed" badges. Populated in
	// app.New; zero-value when no server-side key is configured.
	serverLLMAvailable bool
	serverLLMProvider  string
	serverLLMModel     string

	// Cached backend names (e.g. "firecrawl", "searxng") for UI messaging.
	// Availability itself is computed live per subsystem.
	serverScrapeProvider string
	serverSearchProvider string
}

// pingCache memoizes a subsystem's reachability probe for statusPingTTL so a
// dead backend doesn't get hammered by the UI's status polling.
type pingCache struct {
	mu        sync.Mutex
	checkedAt time.Time
	up        bool
}

const statusPingTTL = 30 * time.Second

// reachable returns cached liveness, refreshing with `ping` when the cache is
// empty or older than statusPingTTL.
func (p *pingCache) reachable(ctx context.Context, ping func(context.Context) error) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Since(p.checkedAt) < statusPingTTL {
		return p.up
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	p.up = ping(pingCtx) == nil
	p.checkedAt = time.Now()
	return p.up
}

// ServerLLM captures the LLM_* env vars the process was started with, so the
// router can report them to the browser without re-reading the environment.
// Zero-value means the process has no server-side LLM configured — BYOK is
// the only way to use AI features on this deployment.
type ServerLLM struct {
	Available bool
	Provider  string
	Model     string
}

// ServerScrape captures the SCRAPER_* env vars the process was started with.
// Empty Provider means the process has no server-side scraper configured —
// dossier enrichment falls back to today's non-scraped behavior, and browser
// BYOK is still available regardless.
type ServerScrape struct {
	Provider string
}

// ServerSearch captures the SEARCH_BASE_URL env var the process was started with.
// Empty Provider means the process has no server-side search provider
// configured — the Dashboard's Discover button is hidden.
type ServerSearch struct {
	Provider string
}

// NewRouter wires handlers, static assets, and middleware into the application router.
func NewRouter(companiesService *companies.Service, dossiersService *dossiers.Service, applicationsService *applications.Service, bragsService *brags.Service, communicationsService *communications.Service, profileService *profile.Service, discoverService *discover.Service, serverLLM ServerLLM, serverScrape ServerScrape, serverSearch ServerSearch, scrapeClient scrape.Client, searchClient search.Client) http.Handler {
	server := &Server{
		companies:           companiesService,
		applications:        applicationsService,
		brags:               bragsService,
		communications:      communicationsService,
		dossiers:            dossiersService,
		profile:             profileService,
		discover:            discoverService,
		scrape:              scrapeClient,
		search:              searchClient,
		serverLLMAvailable:  serverLLM.Available,
		serverLLMProvider:   serverLLM.Provider,
		serverLLMModel:      serverLLM.Model,
		serverScrapeProvider: serverScrape.Provider,
		serverSearchProvider: serverSearch.Provider,
	}

	// 5 req/min per IP, burst 3, evict entries idle > 10min. Applied to
	// LLM-touching routes so the shared demo key cannot be drained by one client.
	llmLimit := newIPLimiter(rate.Every(12*time.Second), 3, 10*time.Minute)
	llm := func(h http.HandlerFunc) http.Handler { return llmLimit.middleware(h) }

	mux := http.NewServeMux()
	// /health returns 200 for readiness probes and uptime monitors. basicAuth
	// bypasses this path so probes don't need credentials.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /", server.rootRedirect)
	mux.HandleFunc("GET /oauth/google/config", server.googleOAuthConfig)
	mux.HandleFunc("POST /oauth/google/token", server.googleTokenExchange)
	mux.HandleFunc("GET /api/llm/server-status", server.rpcLLMServerStatus)
	mux.HandleFunc("GET /api/scrape/server-status", server.rpcScrapeServerStatus)
	mux.HandleFunc("GET /api/search/server-status", server.rpcSearchServerStatus)
	mux.HandleFunc("GET /api/discover/server-status", server.rpcDiscoverServerStatus)
	mux.Handle("POST /api/discover/run", llm(server.rpcDiscoverRun))
	mux.Handle("POST /api/companies/guess-candidate", llm(server.rpcGuessCompanyCandidate))
	mux.Handle("POST /api/dossiers/build", llm(server.rpcBuildDossier))
	mux.Handle("POST /api/applications/extract-job-description", llm(server.rpcExtractJobDescription))
	mux.Handle("POST /api/profile/generate-brag-tags", llm(server.rpcGenerateBragTags))
	mux.Handle("POST /api/profile/extract-brags-from-resume", llm(server.rpcExtractBragsFromResume))
	mux.Handle("POST /api/profile/extract-overview-from-resume", llm(server.rpcExtractOverviewFromResume))
	mux.Handle("POST /api/profile/extract-structured-resume-from-md", llm(server.rpcExtractStructuredResumeFromMd))
	mux.Handle("POST /api/communications/summarize-thread", llm(server.rpcSummarizeThread))
	mux.Handle("POST /api/communications/generate-message", llm(server.rpcGenerateMessage))
	// Subsystem-only endpoints for BYOK-LLM callers with no BYOK scrape/search
	// of their own. The browser assembles the prompt + calls its LLM itself.
	mux.HandleFunc("POST /api/dossiers/scrape", server.rpcDossierScrape)
	mux.HandleFunc("POST /api/applications/scrape", server.rpcApplicationScrape)
	mux.HandleFunc("POST /api/discover/search", server.rpcDiscoverSearch)
	for _, p := range Pages {
		mux.HandleFunc("GET /"+p.Slug, handlerForPage(p))
	}
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))
	return basicAuth(logging(mux))
}

func (s *Server) rootRedirect(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, "/dashboard", http.StatusFound)
}
