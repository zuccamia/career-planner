package http

// Assembles the HTTP server, route table, and service dependencies.

import (
	"net/http"

	"github.com/ngochoang/career-planner/internal/applications"
	"github.com/ngochoang/career-planner/internal/communications"
	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/dossiers"
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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", server.rootRedirect)
	mux.HandleFunc("POST /oauth/google/token", server.googleTokenExchange)
	mux.HandleFunc("GET /api/db/migrations.json", server.migrationsJSON)
	mux.HandleFunc("GET /api/db/enums.json", server.schemaEnums)
	mux.HandleFunc("POST /api/companies/guess-candidate", server.rpcGuessCompanyCandidate)
	mux.HandleFunc("POST /api/dossiers/build", server.rpcBuildDossier)
	mux.HandleFunc("POST /api/applications/extract-job-description", server.rpcExtractJobDescription)
	mux.HandleFunc("POST /api/communications/summarize-thread", server.rpcSummarizeThread)
	mux.HandleFunc("POST /api/communications/generate-message", server.rpcGenerateMessage)
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
