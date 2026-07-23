package http

// Loads templates and injects shared layout data.

import (
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func templateFuncs() template.FuncMap {
	return template.FuncMap{
		"applicationStatusClasses": applicationStatusClasses,
		"applicationEventSummary": applicationEventSummary,
		"humanizeSnakeCase":       humanizeSnakeCase,
		"dict":                     templateDict,
	}
}

func templatePaths(names ...string) ([]string, error) {
	paths := make([]string, 0, len(names)+16)
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", name))
	}

	err := filepath.Walk(filepath.Join("web", "templates", "partials"), func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			return nil
		}
		if filepath.Ext(path) == ".html" {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return paths, nil
}

// parseTemplates loads the base layout together with the requested page templates.
func parseTemplates(names ...string) (*template.Template, error) {
	paths, err := templatePaths(names...)
	if err != nil {
		return nil, err
	}

	tmpl, err := template.New("base").Funcs(templateFuncs()).ParseFiles(paths...)
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
	case "online_assessment":
		return "bg-cyan-100 text-cyan-700"
	case "first_interview":
		return "bg-amber-100 text-amber-800"
	case "second_interview":
		return "bg-orange-100 text-orange-800"
	case "additional_interview":
		return "bg-fuchsia-100 text-fuchsia-700"
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

func applicationEventSummary(eventType, content, fromStatus, toStatus string) string {
	eventType = strings.TrimSpace(strings.ToLower(eventType))
	content = strings.TrimSpace(content)
	fromStatus = strings.TrimSpace(fromStatus)
	toStatus = strings.TrimSpace(toStatus)

	switch eventType {
	case "status_changed":
		if fromStatus != "" && toStatus != "" {
			if content != "" {
				return fmt.Sprintf("Status changed: %s → %s — %s", humanizeSnakeCase(fromStatus), humanizeSnakeCase(toStatus), content)
			}
			return fmt.Sprintf("Status changed: %s → %s", humanizeSnakeCase(fromStatus), humanizeSnakeCase(toStatus))
		}
		if toStatus != "" {
			if content != "" {
				return fmt.Sprintf("Status changed: %s — %s", humanizeSnakeCase(toStatus), content)
			}
			return fmt.Sprintf("Status changed: %s", humanizeSnakeCase(toStatus))
		}
		if content != "" {
			return content
		}
		return "Status changed"
	case "created":
		if content != "" {
			return content
		}
		if toStatus != "" {
			return fmt.Sprintf("Application created: %s", humanizeSnakeCase(toStatus))
		}
		return "Application created"
	default:
		if content != "" {
			return content
		}
		if toStatus != "" {
			if fromStatus != "" {
				return fmt.Sprintf("%s → %s", humanizeSnakeCase(fromStatus), humanizeSnakeCase(toStatus))
			}
			return humanizeSnakeCase(toStatus)
		}
		return humanizeSnakeCase(eventType)
	}
}

func humanizeSnakeCase(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return ""
	}
	value = strings.Join(strings.Fields(strings.ReplaceAll(value, "_", " ")), " ")
	if value == "" {
		return ""
	}
	return strings.ToUpper(value[:1]) + value[1:]
}

func templateDict(values ...any) (map[string]any, error) {
	if len(values)%2 != 0 {
		return nil, errors.New("dict requires an even number of arguments")
	}
	data := make(map[string]any, len(values)/2)
	for i := 0; i < len(values); i += 2 {
		key, ok := values[i].(string)
		if !ok {
			return nil, errors.New("dict keys must be strings")
		}
		data[key] = values[i+1]
	}
	return data, nil
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
