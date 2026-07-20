package http

// Loads templates and injects shared layout data.

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"
)

// parseTemplates loads the base layout together with the requested page templates.
func parseTemplates(names ...string) (*template.Template, error) {
	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", name))
	}
	tmpl, err := template.New("base").ParseFiles(paths...)
	if err != nil {
		return nil, err
	}
	return tmpl, nil
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

	if _, ok := data["EngineeringBlogsCount"]; !ok && s != nil && s.engineeringNotes != nil {
		count, err := s.engineeringNotes.Count(r.Context())
		if err != nil {
			log.Printf("count engineering blog notes for layout: %v", err)
			data["EngineeringBlogsCount"] = 0
		} else {
			data["EngineeringBlogsCount"] = count
		}
	}

	tmpl, err := parseTemplates("base.html", page)
	if err != nil {
		log.Printf("parse templates: %v", err)
		return err
	}
	return tmpl.ExecuteTemplate(w, page, data)
}
