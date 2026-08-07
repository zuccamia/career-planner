package communications

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// TestDirectionsMatchEnumsJSON guards drift between the Go-side Directions
// slice (used by entryActorLabel) and the browser-consumed enums.json.
// Adding or reordering a direction in one place without the other would
// silently make browser dropdowns and server-side validation disagree.
func TestDirectionsMatchEnumsJSON(t *testing.T) {
	path := repoFile(t, "web", "static", "db", "enums.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var payload struct {
		Directions []string `json:"communication_directions"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if !reflect.DeepEqual(payload.Directions, Directions) {
		t.Fatalf("communication_directions drift:\n  Go   = %v\n  JSON = %v", Directions, payload.Directions)
	}
}

// repoFile walks up from this source file until it finds go.mod, then
// joins the supplied path segments. Same trick i18n/testutil uses so tests
// work regardless of the current working directory.
func repoFile(t *testing.T, parts ...string) string {
	t.Helper()
	_, this, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(this)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return filepath.Join(append([]string{dir}, parts...)...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("go.mod not found walking up from %s", filepath.Dir(this))
		}
		dir = parent
	}
}
