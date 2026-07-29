package http

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"

	"github.com/zuccamia/career-planner/internal/i18n"
)

// Local-first handlers. These serve minimal HTML shells; browser JS modules
// render page content by talking to sqlite-wasm and the storage backends. The
// server itself holds no persistent data for this namespace — it only serves
// static files, proxies OAuth, and exposes stateless RPC endpoints.

type localPageData struct {
	Title  string
	Page   string
	Locale string
}

// parseLocalTemplate builds the template set for a page. locale is baked into
// the `t` FuncMap so template calls stay parameterless — `{{ t "nav.home" }}`
// rather than `{{ t $.Locale "nav.home" }}`. layout.html is always first.
func parseLocalTemplate(locale string, names ...string) (*template.Template, error) {
	paths := make([]string, 0, len(names)+1)
	paths = append(paths, filepath.Join("web", "templates", "local", "layout.html"))
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", "local", name))
	}
	funcs := template.FuncMap{
		"t": func(key string, args ...any) string { return i18n.T(locale, key, args...) },
	}
	return template.New("local").Funcs(funcs).ParseFiles(paths...)
}

// renderLocal is the shared handler helper. Each page handler is now a
// one-liner that names its page slug (drives sidebar highlight), the block
// template name, the i18n title key, and the page template file.
func renderLocal(w http.ResponseWriter, r *http.Request, page, block, titleKey, file string) {
	locale := i18n.Resolve(r)
	tmpl, err := parseLocalTemplate(locale, file)
	if err != nil {
		log.Printf("local %s template: %v", page, err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	data := localPageData{
		Title:  i18n.T(locale, titleKey),
		Page:   page,
		Locale: locale,
	}
	if err := tmpl.ExecuteTemplate(w, block, data); err != nil {
		log.Printf("local %s render: %v", page, err)
	}
}

func (s *Server) localHome(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/local/dashboard", http.StatusFound)
}

func (s *Server) localDashboard(w http.ResponseWriter, r *http.Request) {
	renderLocal(w, r, "dashboard", "local_dashboard", "page.dashboard.title", "dashboard.html")
}

func (s *Server) localCompanies(w http.ResponseWriter, r *http.Request) {
	renderLocal(w, r, "companies", "local_companies", "page.companies.title", "companies.html")
}

func (s *Server) localApplications(w http.ResponseWriter, r *http.Request) {
	renderLocal(w, r, "applications", "local_applications", "page.applications.title", "applications.html")
}

func (s *Server) localPeople(w http.ResponseWriter, r *http.Request) {
	renderLocal(w, r, "people", "local_people", "page.people.title", "people.html")
}

func (s *Server) localProfile(w http.ResponseWriter, r *http.Request) {
	renderLocal(w, r, "profile", "local_profile", "page.profile.title", "profile.html")
}

func (s *Server) localSettings(w http.ResponseWriter, r *http.Request) {
	renderLocal(w, r, "settings", "local_settings", "page.settings.title", "settings.html")
}
