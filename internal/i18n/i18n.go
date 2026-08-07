// Package i18n provides a minimal locale-aware string lookup for the server-
// rendered layout shell. Bundles live at web/static/i18n/{en,vi,...}.json so
// the browser (see web/static/js/i18n.mjs) can consume the same source
// of truth via a plain fetch — one bundle format, two readers.
//
// Concurrency contract: Load() must complete before any read call. In
// production Load() runs once from app.New() before the HTTP server accepts
// requests; tests call Load() in setup. If hot-reload is ever added, this
// contract needs a lock or an atomic pointer swap.
package i18n

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// CookieName is the HTTP cookie that carries the user's locale choice.
const CookieName = "lang"

// Bundle is one locale's flat key→translation map.
type Bundle = map[string]string

// Package state, populated by Load and then treated as read-only. supported[0]
// is the default locale used for both request resolution AND missing-key
// fallback. Overridable in tests by reassigning bundlesDir.
var (
	bundles    map[string]Bundle
	supported  []string
	bundlesDir = filepath.Join("web", "static", "i18n")
)

// Load reads /manifest.json to discover which locales exist, then each
// {locale}.json bundle. Not safe to call concurrently with reads.
func Load() error {
	var manifest struct {
		Supported []string `json:"supported"`
	}
	if err := readJSONFile(filepath.Join(bundlesDir, "manifest.json"), &manifest); err != nil {
		return err
	}
	if len(manifest.Supported) == 0 {
		return fmt.Errorf("i18n manifest: supported is empty")
	}
	loaded := make(map[string]Bundle, len(manifest.Supported))
	for _, code := range manifest.Supported {
		var b Bundle
		if err := readJSONFile(filepath.Join(bundlesDir, code+".json"), &b); err != nil {
			return err
		}
		loaded[code] = b
	}
	bundles = loaded
	supported = manifest.Supported
	return nil
}

// T looks up key in locale. Missing keys fall back to the default locale,
// then to the key itself — mirrors the JS helper so partial extraction is
// safe. Extra args feed fmt.Sprintf on the resolved template.
func T(locale, key string, args ...any) string {
	if v, ok := bundles[locale][key]; ok {
		return format(v, args)
	}
	if def := defaultLocale(); def != "" && def != locale {
		if v, ok := bundles[def][key]; ok {
			return format(v, args)
		}
	}
	return key
}

// Resolve picks the locale for a request. Order: `lang` cookie → highest-
// weighted supported tag in Accept-Language → default locale.
func Resolve(r *http.Request) string {
	if c, err := r.Cookie(CookieName); err == nil {
		if code := strings.ToLower(strings.TrimSpace(c.Value)); isSupported(code) {
			return code
		}
	}
	for _, tag := range parseAcceptLanguage(r.Header.Get("Accept-Language")) {
		if isSupported(tag) {
			return tag
		}
		// "vi-VN" → "vi" if the base language is registered.
		if i := strings.Index(tag, "-"); i > 0 && isSupported(tag[:i]) {
			return tag[:i]
		}
	}
	return defaultLocale()
}

func defaultLocale() string {
	if len(supported) == 0 {
		return ""
	}
	return supported[0]
}

func isSupported(code string) bool {
	for _, c := range supported {
		if c == code {
			return true
		}
	}
	return false
}

func format(s string, args []any) string {
	if len(args) == 0 {
		return s
	}
	return fmt.Sprintf(s, args...)
}

func readJSONFile(path string, out any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}
