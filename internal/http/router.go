package http

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/llm"
)

type Server struct {
	companies *companies.Service
}

func NewRouter() http.Handler {
	server := &Server{
		companies: newCompaniesService(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", server.home)
	mux.HandleFunc("GET /companies/new", server.companyNewForm)
	mux.HandleFunc("POST /companies/new", server.companyNewSubmit)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))
	return logging(mux)
}

func parseTemplates(names ...string) (*template.Template, error) {
	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", name))
	}
	tmpl, err := template.ParseFiles(paths...)
	if err != nil {
		return nil, err
	}
	return tmpl, nil
}

func (s *Server) home(w http.ResponseWriter, r *http.Request) {
	data := map[string]any{
		"Title": "Career Planner",
	}
	if err := s.render(w, "index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) companyNewForm(w http.ResponseWriter, r *http.Request) {
	data := map[string]any{
		"Title": "Add company",
	}
	if err := s.render(w, "company_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) companyNewSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	companyName := strings.TrimSpace(r.FormValue("company_name"))
	if companyName == "" {
		data := map[string]any{
			"Title": "Add company",
			"Error": "Company name is required.",
		}
		if err := s.render(w, "company_new.html", data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	candidate, err := s.companies.GuessCandidate(r.Context(), companyName)
	note := "Please review and edit before continuing."
	if err != nil {
		log.Printf("guess company candidate: %v", err)
		note = "Could not verify automatically — please edit the details directly."
	}

	data := map[string]any{
		"Title":        "Company candidate",
		"CompanyName":  companyName,
		"OfficialName": candidate.OfficialName,
		"Website":      candidate.Website,
		"ATSURL":       candidate.ATSURL,
		"ATSProvider":  candidate.ATSProvider,
		"Confidence":   candidate.Confidence,
		"Reasoning":    candidate.Reasoning,
		"Note":         note,
	}
	if err := s.render(w, "company_confirm.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) render(w http.ResponseWriter, page string, data map[string]any) error {
	tmpl, err := parseTemplates("base.html", page)
	if err != nil {
		log.Printf("parse templates: %v", err)
		return err
	}
	return tmpl.ExecuteTemplate(w, page, data)
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

func newCompaniesService() *companies.Service {
	config, err := llm.LoadConfig()
	if err != nil {
		log.Printf("llm config unavailable: %v", err)
		return companies.NewService(nil)
	}
	client := llm.NewClient(config)
	return companies.NewService(client)
}