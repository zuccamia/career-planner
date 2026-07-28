package http

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"
)

// Local-first handlers. These serve minimal HTML shells; browser JS modules
// render page content by talking to sqlite-wasm and the storage backends. The
// server itself holds no persistent data for this namespace — it only serves
// static files, proxies OAuth, and exposes stateless RPC endpoints.

type localPageData struct {
	Title string
	Page  string
}

func parseLocalTemplate(names ...string) (*template.Template, error) {
	paths := make([]string, 0, len(names)+1)
	paths = append(paths, filepath.Join("web", "templates", "local", "layout.html"))
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", "local", name))
	}
	return template.New("local").ParseFiles(paths...)
}

func (s *Server) localHome(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/local/dashboard", http.StatusFound)
}

func (s *Server) localDashboard(w http.ResponseWriter, r *http.Request) {
	tmpl, err := parseLocalTemplate("dashboard.html")
	if err != nil {
		log.Printf("local dashboard template: %v", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, "local_dashboard", localPageData{Title: "Dashboard", Page: "dashboard"}); err != nil {
		log.Printf("local dashboard render: %v", err)
	}
}

func (s *Server) localCompanies(w http.ResponseWriter, r *http.Request) {
	tmpl, err := parseLocalTemplate("companies.html")
	if err != nil {
		log.Printf("local companies template: %v", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, "local_companies", localPageData{Title: "Companies", Page: "companies"}); err != nil {
		log.Printf("local companies render: %v", err)
	}
}

func (s *Server) localApplications(w http.ResponseWriter, r *http.Request) {
	tmpl, err := parseLocalTemplate("applications.html")
	if err != nil {
		log.Printf("local applications template: %v", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, "local_applications", localPageData{Title: "Applications", Page: "applications"}); err != nil {
		log.Printf("local applications render: %v", err)
	}
}

func (s *Server) localPeople(w http.ResponseWriter, r *http.Request) {
	tmpl, err := parseLocalTemplate("people.html")
	if err != nil {
		log.Printf("local people template: %v", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, "local_people", localPageData{Title: "People", Page: "people"}); err != nil {
		log.Printf("local people render: %v", err)
	}
}

func (s *Server) localProfile(w http.ResponseWriter, r *http.Request) {
	tmpl, err := parseLocalTemplate("profile.html")
	if err != nil {
		log.Printf("local profile template: %v", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, "local_profile", localPageData{Title: "Profile", Page: "profile"}); err != nil {
		log.Printf("local profile render: %v", err)
	}
}

func (s *Server) localSettings(w http.ResponseWriter, r *http.Request) {
	tmpl, err := parseLocalTemplate("settings.html")
	if err != nil {
		log.Printf("local settings template: %v", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	if err := tmpl.ExecuteTemplate(w, "local_settings", localPageData{Title: "Settings", Page: "settings"}); err != nil {
		log.Printf("local settings render: %v", err)
	}
}
