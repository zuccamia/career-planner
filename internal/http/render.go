package http

// Loads templates and injects shared layout data.

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"
	"strings"
)

// parseTemplates loads the base layout together with the requested page templates.
func parseTemplates(names ...string) (*template.Template, error) {
	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", name))
	}
	tmpl, err := template.New("base").Funcs(template.FuncMap{
		"applicationStatusClasses": applicationStatusClasses,
	}).ParseFiles(paths...)
	if err != nil {
		return nil, err
	}
	return tmpl, nil
}

func applicationStatusClasses(status string) string {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case "wishlist":
		return "bg-slate-100 text-slate-700"
	case "applied":
		return "bg-blue-100 text-blue-700"
	case "in_process":
		return "bg-amber-100 text-amber-800"
	case "offer":
		return "bg-emerald-100 text-emerald-700"
	case "rejected":
		return "bg-rose-100 text-rose-700"
	case "withdrawn":
		return "bg-violet-100 text-violet-700"
	default:
		return "bg-slate-100 text-slate-700"
	}
}

// render fills shared layout data and executes the requested page template.
func (s *Server) render(w http.ResponseWriter, r *http.Request, page string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}

	if _, ok := data["CompaniesCount"]; !ok && s != nil && s.companies != nil {
		count, err := s.companies.Count(r.Context())
		if err != nil {
			log.Printf("count companies for layout: %v", err)
			data["CompaniesCount"] = 0
		} else {
			data["CompaniesCount"] = count
		}
	}

	if _, ok := data["PeopleCount"]; !ok && s != nil && s.people != nil {
		count, err := s.people.Count(r.Context())
		if err != nil {
			log.Printf("count people for layout: %v", err)
			data["PeopleCount"] = 0
		} else {
			data["PeopleCount"] = count
		}
	}

	if _, ok := data["ApplicationsCount"]; !ok && s != nil && s.applications != nil {
		count, err := s.applications.Count(r.Context())
		if err != nil {
			log.Printf("count applications for layout: %v", err)
			data["ApplicationsCount"] = 0
		} else {
			data["ApplicationsCount"] = count
		}
	}

	if _, ok := data["EngineeringBlogsCount"]; !ok && s != nil && s.engineeringBlogs != nil {
		count, err := s.engineeringBlogs.Count(r.Context())
		if err != nil {
			log.Printf("count engineering blog notes for layout: %v", err)
			data["EngineeringBlogsCount"] = 0
		} else {
			data["EngineeringBlogsCount"] = count
		}
	}

	if _, ok := data["CommunicationThreadsCount"]; !ok && s != nil && s.communications != nil {
		count, err := s.communications.Count(r.Context())
		if err != nil {
			log.Printf("count communication threads for layout: %v", err)
			data["CommunicationThreadsCount"] = 0
		} else {
			data["CommunicationThreadsCount"] = count
		}
	}

	tmpl, err := parseTemplates("base.html", page)
	if err != nil {
		log.Printf("parse templates: %v", err)
		return err
	}
	return tmpl.ExecuteTemplate(w, page, data)
}
