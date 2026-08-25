package llm

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// PromptSets holds one Prompt per locale for a single feature. User is a
// fmt.Sprintf template; the caller interpolates feature inputs before dispatch.
type PromptSets map[string]Prompt

// DefaultPromptLocale is the fallback when a requested locale has no entry.
// Kept independent of internal/i18n to avoid an import cycle.
const DefaultPromptLocale = "en"

// PickPromptSet returns sets[lang], or the DefaultPromptLocale entry when lang
// is missing. Returns a zero Prompt if neither exists — the "en" entry is
// expected to always be present.
func PickPromptSet(sets PromptSets, lang string) Prompt {
	if p, ok := sets[lang]; ok {
		return p
	}
	return sets[DefaultPromptLocale]
}

// promptFile is the on-disk JSON shape at
// web/static/i18n/prompts/{module}/{name}.{locale}.json — the same files the
// browser fetches. Keep in sync with web/static/js/llm/prompts loader.
type promptFile struct {
	Name    string `json:"name"`
	Locale  string `json:"locale"`
	System  string `json:"system"`
	User    string `json:"user"`
	Persona string `json:"persona,omitempty"`
}

// Package state populated by LoadPrompts, then treated as read-only. Same
// concurrency contract as i18n: LoadPrompts must finish before any PromptSet
// read call. In production app.New() invokes it before the HTTP server accepts
// requests.
var promptSets map[string]PromptSets

// LoadPrompts walks dir recursively and loads every {module}/{name}.{locale}.json
// file, grouping them by the slash-style key `{module}/{name}`. Filenames must
// match the {name, locale} in their content — mismatches fail loud rather than
// shadowing an entry.
func LoadPrompts(dir string) error {
	loaded := map[string]PromptSets{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			return nil
		}
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
		// Derive the expected key from the location on disk. Prompt keys are
		// path-style with forward slashes even on Windows: {module}/{name}.
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return fmt.Errorf("rel %s: %w", path, err)
		}
		relSlash := filepath.ToSlash(rel)
		derivedKey := strings.TrimSuffix(strings.TrimSuffix(relSlash, ".json"), "."+pf.Locale)
		if derivedKey != pf.Name {
			return fmt.Errorf("%s: path key %q disagrees with content name %q", path, derivedKey, pf.Name)
		}
		// Verify the filename's locale segment matches too.
		if !strings.HasSuffix(relSlash, "."+pf.Locale+".json") {
			return fmt.Errorf("%s: filename locale disagrees with content (expected suffix .%s.json)", path, pf.Locale)
		}
		if loaded[pf.Name] == nil {
			loaded[pf.Name] = PromptSets{}
		}
		loaded[pf.Name][pf.Locale] = Prompt{
			System:  pf.System,
			User:    pf.User,
			Persona: pf.Persona,
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk prompts dir %s: %w", dir, err)
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
