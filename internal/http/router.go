package http

// Assembles the HTTP server, route table, and service dependencies.

import (
	"net/http"
	"time"

	"golang.org/x/time/rate"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/dossiers"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

// Server bundles the services needed by remaining HTTP handlers. All are
// stateless LLM helpers — the browser owns persistence.
type Server struct {
	companies      *companies.Service
	applications   *applications.Service
	brags          *brags.Service
	communications *communications.Service
	dossiers       *dossiers.Service

	// Optional server-side scraper. Non-nil only when SCRAPER_* env vars are
	// configured. Used by rpcBuildDossier to enrich the LLM prompt with
	// scraped website markdown, and by the ATS registry as the generic
	// fallback fetcher. Never used on the browser BYOK path — browsers call
	// the scraper directly.
	scrape scrape.Client

	// Cached view of the LLM_* env vars this process was started with. Read
	// via GET /api/llm/server-status so the browser can pick between the
	// "Server · <model>" and "AI: setup needed" badges. Populated in
	// app.New; zero-value when no server-side key is configured.
	serverLLMAvailable bool
	serverLLMProvider  string
	serverLLMModel     string

	// Cached view of the SCRAPER_* env vars. Read via
	// GET /api/scrape/server-status so the settings panel can tell the user
	// whether the server already has a scraper wired up.
	serverScrapeAvailable bool
	serverScrapeBackend   string
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
// Zero-value means the process has no server-side scraper configured — dossier
// enrichment falls back to today's non-scraped behavior, and browser BYOK is
// still available regardless.
type ServerScrape struct {
	Available bool
	Backend   string
}

// NewRouter wires handlers, static assets, and middleware into the application router.
func NewRouter(companiesService *companies.Service, dossiersService *dossiers.Service, applicationsService *applications.Service, bragsService *brags.Service, communicationsService *communications.Service, serverLLM ServerLLM, serverScrape ServerScrape, scrapeClient scrape.Client) http.Handler {
	server := &Server{
		companies:             companiesService,
		applications:          applicationsService,
		brags:                 bragsService,
		communications:        communicationsService,
		dossiers:              dossiersService,
		scrape:                scrapeClient,
		serverLLMAvailable:    serverLLM.Available,
		serverLLMProvider:     serverLLM.Provider,
		serverLLMModel:        serverLLM.Model,
		serverScrapeAvailable: serverScrape.Available,
		serverScrapeBackend:   serverScrape.Backend,
	}

	// 5 req/min per IP, burst 3, evict entries idle > 10min. Applied to
	// LLM-touching routes so the shared demo key cannot be drained by one client.
	llmLimit := newIPLimiter(rate.Every(12*time.Second), 3, 10*time.Minute)
	llm := func(h http.HandlerFunc) http.Handler { return llmLimit.middleware(h) }

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", server.rootRedirect)
	mux.HandleFunc("GET /oauth/google/config", server.googleOAuthConfig)
	mux.HandleFunc("POST /oauth/google/token", server.googleTokenExchange)
	mux.HandleFunc("GET /api/db/migrations.json", server.migrationsJSON)
	mux.HandleFunc("GET /api/db/enums.json", server.schemaEnums)
	mux.HandleFunc("GET /api/llm/server-status", server.rpcLLMServerStatus)
	mux.HandleFunc("GET /api/scrape/server-status", server.rpcScrapeServerStatus)
	mux.Handle("POST /api/companies/guess-candidate", llm(server.rpcGuessCompanyCandidate))
	mux.Handle("POST /api/dossiers/build", llm(server.rpcBuildDossier))
	mux.Handle("POST /api/applications/extract-job-description", llm(server.rpcExtractJobDescription))
	mux.Handle("POST /api/profile/generate-brag-tags", llm(server.rpcGenerateBragTags))
	mux.Handle("POST /api/communications/summarize-thread", llm(server.rpcSummarizeThread))
	mux.Handle("POST /api/communications/generate-message", llm(server.rpcGenerateMessage))
	// BYOK helpers — the browser calls these before + after hitting the user's
	// own provider. /prompts/{name} assembles the prompt to send; /parse/{name}
	// sanitizes the raw response. /prompts for extract-job-description does
	// trigger an ATS URL fetch — same SSRF-hardened fetcher the server-side
	// LLM path uses.
	mux.HandleFunc("POST /api/llm/prompts/{name}", server.rpcBYOKPrompt)
	mux.HandleFunc("POST /api/llm/parse/{name}", server.rpcBYOKParse)
	mux.HandleFunc("GET /local/", server.localHome)
	mux.HandleFunc("GET /local/dashboard", server.localDashboard)
	mux.HandleFunc("GET /local/companies", server.localCompanies)
	mux.HandleFunc("GET /local/applications", server.localApplications)
	mux.HandleFunc("GET /local/people", server.localPeople)
	mux.HandleFunc("GET /local/profile", server.localProfile)
	mux.HandleFunc("GET /local/settings", server.localSettings)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))
	return logging(mux)
}

func (s *Server) rootRedirect(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, "/local/dashboard", http.StatusFound)
}
