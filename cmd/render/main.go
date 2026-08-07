// cmd/render dumps every server-rendered route × locale as static HTML into
// an output directory, alongside a copy of web/static/**. The resulting
// tree is what gets uploaded to GH Pages.
//
// The router is booted in-memory via app.New; requests are dispatched
// through httptest.NewRecorder so we never open a network port. The
// StaticHost flag is flipped before app.New so every rendered page carries
// <meta name="static-host" content="true">.

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"

	"github.com/zuccamia/career-planner/internal/app"
	apphttp "github.com/zuccamia/career-planner/internal/http"
	"github.com/zuccamia/career-planner/internal/i18n"
)

// Pages come from apphttp.Pages — the same slice router.go iterates
// when installing handlers. One source of truth means adding a new page
// only requires appending to that slice; no update needed here.

func main() {
	outDir := flag.String("out", "dist", "output directory")
	flag.Parse()
	if err := run(*outDir); err != nil {
		log.Fatal(err)
	}
}

func run(outDir string) error {
	apphttp.StaticHost = true
	a := app.New()
	router := a.Router

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("mkdir out: %w", err)
	}

	locales, err := i18nLocales()
	if err != nil {
		return err
	}

	for _, locale := range locales {
		for _, p := range apphttp.Pages {
			body, err := dispatch(router, "/"+p.Slug, locale)
			if err != nil {
				return err
			}
			path := filepath.Join(outDir, locale, p.File)
			if err := writeFile(path, body); err != nil {
				return err
			}
		}
	}

	if err := copyTree(filepath.Join("web", "static"), filepath.Join(outDir, "static")); err != nil {
		return fmt.Errorf("copy static: %w", err)
	}

	if err := writeFile(filepath.Join(outDir, "index.html"), []byte(indexHTML(locales))); err != nil {
		return err
	}

	log.Printf("rendered %d locales × %d pages → %s", len(locales), len(apphttp.Pages), outDir)
	return nil
}

// dispatch executes an in-memory GET against router with a `lang` cookie set
// to the target locale. Returns the raw response body or an error when the
// handler responded with a non-2xx status.
func dispatch(router http.Handler, path, locale string) ([]byte, error) {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.AddCookie(&http.Cookie{Name: i18n.CookieName, Value: locale})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	res := rec.Result()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("dispatch %s (locale %s): HTTP %d", path, locale, res.StatusCode)
	}
	return io.ReadAll(res.Body)
}

func i18nLocales() ([]string, error) {
	data, err := os.ReadFile(filepath.Join("web", "static", "i18n", "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("read i18n manifest: %w", err)
	}
	var m struct {
		Supported []string `json:"supported"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse i18n manifest: %w", err)
	}
	if len(m.Supported) == 0 {
		return nil, fmt.Errorf("i18n manifest: no supported locales")
	}
	return m.Supported, nil
}

func writeFile(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o644)
}

// copyTree recursively copies src into dst, creating dst if needed.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return writeFile(target, data)
	})
}

// indexHTML returns a tiny language-picker page that redirects to
// {locale}/dashboard.html based on the browser's preferred language.
func indexHTML(locales []string) string {
	quoted := make([]string, 0, len(locales))
	for _, l := range locales {
		quoted = append(quoted, `"`+l+`"`)
	}
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Career Planner</title></head>
<body><script>
  const supported = [` + strings.Join(quoted, ",") + `];
  const cookie = document.cookie.match(/(?:^|; )lang=([^;]+)/)?.[1];
  const nav = (navigator.language || '').toLowerCase().split('-')[0];
  const lang = supported.includes(cookie) ? cookie : (supported.includes(nav) ? nav : supported[0]);
  location.replace('./' + lang + '/dashboard.html');
</script></body></html>
`
}
