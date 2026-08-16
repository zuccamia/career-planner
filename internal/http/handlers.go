package http

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/zuccamia/career-planner/internal/i18n"
)

// Local-first handlers. These serve minimal HTML shells; browser JS modules
// render page content by talking to sqlite-wasm and the storage backends. The
// server itself holds no persistent data for this namespace — it only serves
// static files, proxies OAuth, and exposes stateless RPC endpoints.

type pageData struct {
	Title      string
	Page       string
	Locale     string
	Nav        []NavGroup
	StaticHost bool
}

// StaticHost is stamped into every rendered layout as a <meta> tag so the
// browser can tell whether it was served by the live Go server or dumped
// ahead of time for a static host. Defaults false (live-server case);
// pre-render tooling flips it to true before dispatching requests.
//
// Set-once-at-boot state — no mutex. The live server never mutates it
// after startup, and any pre-render caller is single-threaded.
var StaticHost bool

// urlForPage maps a page identifier (like "dashboard" or "companies?new=1"
// or "settings#ai-provider") to the right relative URL for the current host
// mode. All pages live at the root (or /{locale}/ on static), so a bare
// relative href resolves correctly from any other page — no leading `/` or
// `./` needed. Static builds add `.html` before any query/hash suffix.
func urlForPage(page string) string {
	if !StaticHost {
		return page
	}
	i := strings.IndexAny(page, "?#")
	if i < 0 {
		return page + ".html"
	}
	return page[:i] + ".html" + page[i:]
}

// NavItem drives one <a> in the sidebar. CountKey is optional — when set, the
// template renders a `data-sidebar-count="…"` badge that JS populates.
type NavItem struct {
	Page     string
	Href     string
	Icon     string
	Label    string
	CountKey string
}

type NavGroup struct {
	Key   string // matches nav.group.<key> i18n keys
	Label string
	Items []NavItem
}

// buildNav is the one source of truth for the sidebar layout. Keeping it in Go
// mirrors the JS-side NAV_GROUPS map used by pageHeader, so a change here + the
// same page → group mapping in ui/components.mjs keeps the eyebrow and sidebar
// aligned.
func buildNav(locale string) []NavGroup {
	tt := func(k string) string { return i18n.T(locale, k) }
	return []NavGroup{
		{Key: "workspace", Label: tt("nav.group.workspace"), Items: []NavItem{
			{Page: "dashboard", Href: urlForPage("dashboard"), Icon: "chartBar", Label: tt("nav.dashboard")},
			{Page: "profile", Href: urlForPage("profile"), Icon: "profileCard", Label: tt("nav.profile")},
		}},
		{Key: "collections", Label: tt("nav.group.collections"), Items: []NavItem{
			{Page: "companies", Href: urlForPage("companies"), Icon: "companies", Label: tt("nav.companies"), CountKey: "companies"},
			{Page: "people", Href: urlForPage("people"), Icon: "people", Label: tt("nav.people"), CountKey: "people"},
			{Page: "applications", Href: urlForPage("applications"), Icon: "applications", Label: tt("nav.applications"), CountKey: "applications"},
		}},
		{Key: "system", Label: tt("nav.group.system"), Items: []NavItem{
			{Page: "settings", Href: urlForPage("settings"), Icon: "settings", Label: tt("nav.settings")},
		}},
	}
}

// parseTemplate builds the template set for a page. locale is baked into
// the `t` FuncMap so template calls stay parameterless — `{{ t "nav.home" }}`
// rather than `{{ t $.Locale "nav.home" }}`. layout.html is always first.
func parseTemplate(locale string, names ...string) (*template.Template, error) {
	paths := make([]string, 0, len(names)+1)
	paths = append(paths, filepath.Join("web", "templates", "layout.html"))
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", name))
	}
	funcs := template.FuncMap{
		"t":      func(key string, args ...any) string { return i18n.T(locale, key, args...) },
		"urlFor": urlForPage,
	}
	return template.New("page").Funcs(funcs).ParseFiles(paths...)
}

// renderPage is the shared handler body used by every Page in Pages. Loads
// the layout + the page's own template, populates pageData, and executes
// the named block.
func renderPage(w http.ResponseWriter, r *http.Request, page, block, titleKey, file string) {
	locale := i18n.Resolve(r)
	tmpl, err := parseTemplate(locale, file)
	if err != nil {
		log.Printf("page %s template: %v", page, err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	data := pageData{
		Title:      i18n.T(locale, titleKey),
		Page:       page,
		Locale:     locale,
		Nav:        buildNav(locale),
		StaticHost: StaticHost,
	}
	if err := tmpl.ExecuteTemplate(w, block, data); err != nil {
		log.Printf("page %s render: %v", page, err)
	}
}

// Page describes one server-rendered shell page. Registered by router.go
// and iterated by cmd/render — single source of truth so adding a new page
// means appending one row here + a template file, with no bookkeeping to
// update anywhere else.
type Page struct {
	Slug     string // "dashboard" — used in URLs and sidebar highlighting
	Block    string // template block name, e.g. "dashboard"
	TitleKey string // i18n key for the <title> tag
	File     string // template filename under web/templates/
}

var Pages = []Page{
	{Slug: "dashboard", Block: "dashboard", TitleKey: "page.dashboard.title", File: "dashboard.html"},
	{Slug: "companies", Block: "companies", TitleKey: "page.companies.title", File: "companies.html"},
	{Slug: "applications", Block: "applications", TitleKey: "page.applications.title", File: "applications.html"},
	{Slug: "people", Block: "people", TitleKey: "page.people.title", File: "people.html"},
	{Slug: "profile", Block: "profile", TitleKey: "page.profile.title", File: "profile.html"},
	{Slug: "settings", Block: "settings", TitleKey: "page.settings.title", File: "settings.html"},
}

// handlerForPage returns the http.HandlerFunc that renders p. Extracted
// so router.go can install one handler per Pages entry via a loop.
func handlerForPage(p Page) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		renderPage(w, r, p.Slug, p.Block, p.TitleKey, p.File)
	}
}
