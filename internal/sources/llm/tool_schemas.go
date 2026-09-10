package llm

// Loads tool-call function schemas from web/static/tool-schemas/{module}/
// {name}.json — the same files the browser fetches. Locale-agnostic.

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Loaded once at boot, read-only thereafter (same contract as promptSets).
var toolSchemas map[string][]ChatTool

// LoadToolSchemas walks dir recursively; keys are {module}/{name} derived
// from the path (mirrors LoadPrompts).
func LoadToolSchemas(dir string) error {
	loaded := map[string][]ChatTool{}
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
		var tools []ChatTool
		if err := json.Unmarshal(data, &tools); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return fmt.Errorf("rel %s: %w", path, err)
		}
		key := strings.TrimSuffix(filepath.ToSlash(rel), ".json")
		loaded[key] = tools
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk tool-schemas dir %s: %w", dir, err)
	}
	toolSchemas = loaded
	return nil
}

// ToolSchema panics on unknown keys — programming error, not runtime.
func ToolSchema(name string) []ChatTool {
	tools, ok := toolSchemas[name]
	if !ok {
		panic(fmt.Sprintf("llm: tool schema %q not loaded (did you call LoadToolSchemas?)", name))
	}
	return tools
}
