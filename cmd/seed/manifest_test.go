package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// TestManifestMatchesSQLFiles guards drift between
// web/static/db/migrations/manifest.json (what the browser reads to know
// which files to fetch) and the actual SQL files on disk. Adding a new
// migration without updating the manifest — or vice versa — silently makes
// the browser and cmd/seed disagree on the migration set.
func TestManifestMatchesSQLFiles(t *testing.T) {
	manifestPath := filepath.Join(migrationsDir, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read %s: %v", manifestPath, err)
	}
	var manifest []string
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("parse %s: %v", manifestPath, err)
	}

	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		t.Fatalf("read %s: %v", migrationsDir, err)
	}
	var onDisk []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".sql" {
			onDisk = append(onDisk, e.Name())
		}
	}
	sort.Strings(onDisk)

	// Manifest ordering matters (it drives migration application order), so
	// compare a sorted copy against onDisk.
	sortedManifest := append([]string(nil), manifest...)
	sort.Strings(sortedManifest)
	if !reflect.DeepEqual(sortedManifest, onDisk) {
		t.Fatalf("manifest drift:\n  manifest = %v\n  on-disk  = %v", manifest, onDisk)
	}
}
