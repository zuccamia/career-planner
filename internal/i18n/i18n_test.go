package i18n

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func setupBundles(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	writeJSON(t, filepath.Join(dir, "manifest.json"), `{"supported":["en","vi"]}`)
	writeJSON(t, filepath.Join(dir, "en.json"), `{"hi":"Hello","named":"Hello, %s!","only_en":"english"}`)
	writeJSON(t, filepath.Join(dir, "vi.json"), `{"hi":"Xin chào","named":"Xin chào, %s!"}`)
	origDir := bundlesDir
	bundlesDir = dir
	bundles = nil
	supported = nil
	t.Cleanup(func() {
		bundlesDir = origDir
		bundles = nil
		supported = nil
	})
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func writeJSON(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestTFallbackAndInterpolation(t *testing.T) {
	setupBundles(t)
	cases := []struct {
		name    string
		locale  string
		key     string
		args    []any
		want    string
	}{
		{"active hit", "vi", "hi", nil, "Xin chào"},
		{"active with arg", "vi", "named", []any{"Hoang"}, "Xin chào, Hoang!"},
		{"fallback to en", "vi", "only_en", nil, "english"},
		{"missing key returns key", "vi", "missing", nil, "missing"},
		{"default locale direct", "en", "hi", nil, "Hello"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := T(tc.locale, tc.key, tc.args...)
			if got != tc.want {
				t.Fatalf("T(%q,%q,%v)=%q want %q", tc.locale, tc.key, tc.args, got, tc.want)
			}
		})
	}
}

func TestResolvePrefersCookie(t *testing.T) {
	setupBundles(t)
	r, _ := http.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "vi"})
	r.Header.Set("Accept-Language", "en-US,en;q=0.9")
	if got := Resolve(r); got != "vi" {
		t.Fatalf("cookie should win: got %q", got)
	}
}

func TestResolveFallsBackToAcceptLanguage(t *testing.T) {
	setupBundles(t)
	r, _ := http.NewRequest("GET", "/", nil)
	r.Header.Set("Accept-Language", "fr-FR,vi;q=0.8,en;q=0.5")
	if got := Resolve(r); got != "vi" {
		t.Fatalf("expected vi from Accept-Language, got %q", got)
	}
}

func TestResolveHandlesLangOnlyPrefix(t *testing.T) {
	setupBundles(t)
	r, _ := http.NewRequest("GET", "/", nil)
	r.Header.Set("Accept-Language", "vi-VN,en;q=0.5")
	if got := Resolve(r); got != "vi" {
		t.Fatalf("expected vi from vi-VN prefix, got %q", got)
	}
}

func TestResolveDefaults(t *testing.T) {
	setupBundles(t)
	r, _ := http.NewRequest("GET", "/", nil)
	if got := Resolve(r); got != "en" {
		t.Fatalf("expected default en, got %q", got)
	}
}

func TestResolveRejectsUnsupportedCookie(t *testing.T) {
	setupBundles(t)
	r, _ := http.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "zz"})
	if got := Resolve(r); got != "en" {
		t.Fatalf("unsupported cookie should fall back, got %q", got)
	}
}
