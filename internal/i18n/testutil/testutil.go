// Package testutil exposes helpers for tests that need to reason about the
// real, checked-in i18n manifest — locale list and bundle directory. Kept out
// of package i18n proper so production code doesn't gain testing.TB in its
// signatures.
package testutil

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// MustLoadPrompts hydrates llm.PromptSet + llm.ToolSchema for the whole test
// binary. Meant to be called from a package-level init() in _test.go so it
// fires before any TestFoo touches a prompt or tool-schema getter. Fatal-logs
// on failure since tests cannot meaningfully continue without them loaded.
func MustLoadPrompts() {
	root := repoRootFromCaller()
	if err := llm.LoadPrompts(filepath.Join(root, "web", "static", "i18n", "prompts")); err != nil {
		log.Fatalf("testutil: load prompts: %v", err)
	}
	if err := llm.LoadToolSchemas(filepath.Join(root, "web", "static", "tool-schemas")); err != nil {
		log.Fatalf("testutil: load tool schemas: %v", err)
	}
}

// repoRootFromCaller walks up from this source file's directory to the repo
// root (go.mod). No *testing.TB dependency — usable from init().
func repoRootFromCaller() string {
	_, this, _, _ := runtime.Caller(0)
	dir := filepath.Dir(this)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			log.Fatalf("testutil: go.mod not found walking up from %s", filepath.Dir(this))
		}
		dir = parent
	}
}

// Locales returns the list of locales in web/static/i18n/manifest.json.
// Fatals the test if the manifest is missing or malformed.
func Locales(t testing.TB) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(BundlesDir(t), "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var m struct {
		Supported []string `json:"supported"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	if len(m.Supported) == 0 {
		t.Fatal("manifest.supported is empty")
	}
	return m.Supported
}

// PromptsDir returns the absolute path to web/static/i18n/prompts in the
// checked-out repo. Same root-walk as BundlesDir.
func PromptsDir(t testing.TB) string {
	t.Helper()
	return filepath.Join(BundlesDir(t), "prompts")
}

// BundlesDir returns the absolute path to web/static/i18n in the checked-out
// repo. Locates the project root by walking up from this file's directory
// until it finds go.mod — works regardless of which package the test runs in.
func BundlesDir(t testing.TB) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	for range 10 {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return filepath.Join(dir, "web", "static", "i18n")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("go.mod not found walking up from %s", filepath.Dir(thisFile))
	return ""
}
