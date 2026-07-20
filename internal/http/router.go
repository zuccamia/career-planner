package http

// Assembles the HTTP server, route table, and service dependencies.

import (
	"net/http"
	"strings"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/dossiers"
	"github.com/ngochoang/career-planner/internal/engineeringnotes"
	"github.com/ngochoang/career-planner/internal/people"
)

// Server bundles the services and runtime options needed by HTTP handlers.
type Server struct {
	companies        *companies.Service
	dossiers         *dossiers.Service
	engineeringNotes *engineeringnotes.Service
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
func NewRouter(companiesService *companies.Service, dossiersService *dossiers.Service, engineeringNotesService *engineeringnotes.Service, peopleService *people.Service, options Options) http.Handler {
	server := &Server{
		companies:        companiesService,
		dossiers:         dossiersService,
		engineeringNotes: engineeringNotesService,
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
	mux.HandleFunc("POST /companies/{id}/engineering-notes", server.companyCreateEngineeringNote)
	mux.HandleFunc("POST /engineering-blogs/{noteID}/edit", server.engineeringBlogEditSubmit)
	mux.HandleFunc("POST /engineering-blogs/{noteID}/delete", server.engineeringBlogDelete)
	mux.HandleFunc("GET /engineering-blogs", server.engineeringBlogsIndex)
	mux.HandleFunc("GET /people", server.peopleIndex)
	mux.HandleFunc("GET /people/new", server.personNewForm)
	mux.HandleFunc("POST /people", server.personCreate)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))
	return logging(mux)
}
