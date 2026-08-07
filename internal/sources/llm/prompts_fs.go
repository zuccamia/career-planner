package llm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// promptFile is the on-disk JSON shape at
// web/static/i18n/prompts/{name}.{locale}.json — the same files the browser
// fetches. Keep in sync with web/static/js/llm/prompts loader.
type promptFile struct {
	Name   string `json:"name"`
	Locale string `json:"locale"`
	System string `json:"system"`
	User   string `json:"user"`
}

// Package state populated by LoadPrompts, then treated as read-only. Same
// concurrency contract as i18n: LoadPrompts must finish before any PromptSet
// read call. In production app.New() invokes it before the HTTP server accepts
// requests.
var promptSets map[string]PromptSets

// LoadPrompts reads every {name}.{locale}.json under dir and groups them by
// name into PromptSets. Filenames must match the {name, locale} in their
// content — mismatches fail loud rather than shadowing an entry.
func LoadPrompts(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read prompts dir %s: %w", dir, err)
	}
	loaded := map[string]PromptSets{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		var pf promptFile
		if err := json.Unmarshal(data, &pf); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		if pf.Name == "" || pf.Locale == "" {
			return fmt.Errorf("%s: name and locale required", path)
		}
		expected := pf.Name + "." + pf.Locale + ".json"
		if e.Name() != expected {
			return fmt.Errorf("%s: filename disagrees with content (expected %s)", path, expected)
		}
		if loaded[pf.Name] == nil {
			loaded[pf.Name] = PromptSets{}
		}
		loaded[pf.Name][pf.Locale] = Prompt{System: pf.System, User: pf.User}
	}
	promptSets = loaded
	return nil
}

// PromptSet returns the loaded set for a feature. Panics if LoadPrompts was
// not called or the name is unknown — both are programming errors, not
// runtime conditions callers can recover from.
func PromptSet(name string) PromptSets {
	set, ok := promptSets[name]
	if !ok {
		panic(fmt.Sprintf("llm: prompt set %q not loaded (did you call LoadPrompts?)", name))
	}
	return set
}
