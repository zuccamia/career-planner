package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	apphttp "github.com/zuccamia/career-planner/internal/http"
)

// TestRenderProducesExpectedTree runs the renderer against a tmpdir and
// asserts every expected file exists, every rendered HTML carries the
// static-host=true meta tag, index.html is present, and web/static/**
// landed under dist/static/**.
func TestRenderProducesExpectedTree(t *testing.T) {
	// Renderer needs to run from repo root (loads i18n bundles from a
	// relative path). Save & restore cwd around the test.
	origWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	defer os.Chdir(origWD)
	if err := os.Chdir(filepath.Join("..", "..")); err != nil {
		t.Fatalf("chdir repo root: %v", err)
	}

	outDir := t.TempDir()
	if err := run(outDir); err != nil {
		t.Fatalf("run: %v", err)
	}

	// Every locale × every page should exist and carry the static-host tag.
	locales, err := i18nLocales()
	if err != nil {
		t.Fatalf("i18nLocales: %v", err)
	}
	for _, locale := range locales {
		for _, p := range apphttp.Pages {
			path := filepath.Join(outDir, locale, p.File)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", path, err)
			}
			if !bytes.Contains(data, []byte(`name="static-host" content="true"`)) {
				t.Errorf("%s: missing static-host=true meta tag", path)
			}
			if bytes.Contains(data, []byte(`name="static-host" content="false"`)) {
				t.Errorf("%s: still carries static-host=false", path)
			}
		}
	}

	// Root index.html present.
	if _, err := os.Stat(filepath.Join(outDir, "index.html")); err != nil {
		t.Errorf("dist/index.html missing: %v", err)
	}

	// Static assets copied.
	for _, rel := range []string{
		"static/app.css",
		"static/js/main.mjs",
		"static/i18n/manifest.json",
		"static/db/enums.json",
		"static/db/migrations/manifest.json",
		"static/db/migrations/001_init.sql",
		"static/i18n/prompts/guess-candidate.en.json",
	} {
		if _, err := os.Stat(filepath.Join(outDir, rel)); err != nil {
			t.Errorf("expected %s in dist: %v", rel, err)
		}
	}
}
