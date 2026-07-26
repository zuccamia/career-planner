package http

// Assembles the HTTP server, route table, and service dependencies.

import (
	"net/http"
	"time"

	"golang.org/x/time/rate"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/dossiers"
)

// Server bundles the services needed by remaining HTTP handlers. All are
// stateless LLM helpers — the browser owns persistence.
type Server struct {
	companies      *companies.Service
	applications   *applications.Service
	communications *communications.Service
	dossiers       *dossiers.Service
}

// NewRouter wires handlers, static assets, and middleware into the application router.
func NewRouter(companiesService *companies.Service, dossiersService *dossiers.Service, applicationsService *applications.Service, communicationsService *communications.Service) http.Handler {
	server := &Server{
		companies:      companiesService,
		applications:   applicationsService,
		communications: communicationsService,
		dossiers:       dossiersService,
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
	mux.Handle("POST /api/companies/guess-candidate", llm(server.rpcGuessCompanyCandidate))
	mux.Handle("POST /api/dossiers/build", llm(server.rpcBuildDossier))
	mux.Handle("POST /api/applications/extract-job-description", llm(server.rpcExtractJobDescription))
	mux.Handle("POST /api/communications/summarize-thread", llm(server.rpcSummarizeThread))
	mux.Handle("POST /api/communications/generate-message", llm(server.rpcGenerateMessage))
	mux.HandleFunc("GET /local/", server.localHome)
	mux.HandleFunc("GET /local/dashboard", server.localDashboard)
	mux.HandleFunc("GET /local/companies", server.localCompanies)
	mux.HandleFunc("GET /local/applications", server.localApplications)
	mux.HandleFunc("GET /local/people", server.localPeople)
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
