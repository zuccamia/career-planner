package http

// Assembles the HTTP server, route table, and service dependencies.

import (
	"net/http"
	"strings"

	"github.com/ngochoang/career-planner/internal/communications"
	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/dossiers"
	"github.com/ngochoang/career-planner/internal/engineering_blogs"
	"github.com/ngochoang/career-planner/internal/people"
)

// Server bundles the services and runtime options needed by HTTP handlers.
type Server struct {
	companies        *companies.Service
	communications   *communications.Service
	dossiers         *dossiers.Service
	engineeringBlogs *engineering_blogs.Service
	people           *people.Service
	environment      string
	databasePath     string
}

// Options carries environment-specific configuration for the HTTP server.
type Options struct {
	Environment  string
	DatabasePath string
}

// NewRouter wires handlers, static assets, and middleware into the application router.
func NewRouter(companiesService *companies.Service, dossiersService *dossiers.Service, engineeringBlogsService *engineering_blogs.Service, peopleService *people.Service, communicationsService *communications.Service, options Options) http.Handler {
	server := &Server{
		companies:        companiesService,
		communications:   communicationsService,
		dossiers:         dossiersService,
		engineeringBlogs: engineeringBlogsService,
		people:           peopleService,
		environment:      strings.TrimSpace(options.Environment),
		databasePath:     strings.TrimSpace(options.DatabasePath),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /test/reset", server.testReset)
	mux.HandleFunc("GET /", server.home)
	mux.HandleFunc("GET /companies", server.companiesIndex)
	mux.HandleFunc("GET /companies/new", server.companyNewForm)
	mux.HandleFunc("POST /companies/new", server.companyNewSubmit)
	mux.HandleFunc("POST /companies", server.companyCreate)
	mux.HandleFunc("GET /companies/{id}", server.companyShow)
	mux.HandleFunc("GET /companies/{id}/engineering-blogs", server.companyEngineeringBlogs)
	mux.HandleFunc("GET /engineering-blogs/{noteID}/edit", server.engineeringBlogEditForm)
	mux.HandleFunc("GET /companies/{id}/edit", server.companyEditForm)
	mux.HandleFunc("POST /companies/{id}/edit", server.companyEditSubmit)
	mux.HandleFunc("POST /companies/{id}/delete", server.companyDelete)
	mux.HandleFunc("POST /companies/{id}/dossier", server.companyBuildDossier)
	mux.HandleFunc("POST /companies/{id}/engineering-blogs", server.companyCreateEngineeringBlog)
	mux.HandleFunc("POST /engineering-blogs/{noteID}/edit", server.engineeringBlogEditSubmit)
	mux.HandleFunc("POST /engineering-blogs/{noteID}/delete", server.engineeringBlogDelete)
	mux.HandleFunc("GET /engineering-blogs", server.engineeringBlogsIndex)
	mux.HandleFunc("GET /people", server.peopleIndex)
	mux.HandleFunc("GET /people/new", server.personNewForm)
	mux.HandleFunc("GET /people/{id}", server.personShow)
	mux.HandleFunc("GET /people/{id}/edit", server.personEditForm)
	mux.HandleFunc("POST /people", server.personCreate)
	mux.HandleFunc("POST /people/{id}/edit", server.personEditSubmit)
	mux.HandleFunc("POST /people/{id}/delete", server.personDelete)
	mux.HandleFunc("POST /people/{id}/communication-threads", server.communicationThreadCreate)
	mux.HandleFunc("GET /communication-threads/{id}", server.communicationThreadShow)
	mux.HandleFunc("POST /communication-threads/{id}/close", server.communicationThreadClose)
	mux.HandleFunc("POST /communication-threads/{id}/reopen", server.communicationThreadReopen)
	mux.HandleFunc("GET /communication-threads/{id}/entries/new", server.communicationEntryNewForm)
	mux.HandleFunc("POST /communication-threads/{id}/entries", server.communicationEntryCreate)
	mux.HandleFunc("POST /communication-entries/{entryID}/delete", server.communicationEntryDelete)
	mux.HandleFunc("POST /communication-threads/{id}/generated-entry", server.communicationGeneratedEntryCreate)
	mux.HandleFunc("POST /communication-threads/{id}/summarize", server.communicationThreadSummarize)
	mux.HandleFunc("POST /communication-threads/{id}/generate", server.communicationMessageGenerate)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))
	return logging(mux)
}
