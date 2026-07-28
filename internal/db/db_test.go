package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// latestVersion returns the version of the highest-numbered migration.
// Fails the test if no migrations are loaded (an init() invariant).
func latestVersion(t *testing.T) int {
	t.Helper()
	ms := Migrations()
	if len(ms) == 0 {
		t.Fatal("no migrations loaded")
	}
	return ms[len(ms)-1].Version
}

func readUserVersion(t *testing.T, db *sql.DB) int {
	t.Helper()
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	return v
}

func TestMigrationsAreSequentialFromOne(t *testing.T) {
	ms := Migrations()
	if len(ms) == 0 {
		t.Fatal("expected at least one migration")
	}
	for i, m := range ms {
		if m.Version != i+1 {
			t.Fatalf("migration at index %d has version %d, want %d", i, m.Version, i+1)
		}
		if m.Name == "" {
			t.Fatalf("migration %d has empty name", m.Version)
		}
		if m.SQL == "" {
			t.Fatalf("migration %d has empty SQL", m.Version)
		}
	}
}

func TestOpenAppliesAllMigrationsOnFreshDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.sqlite")
	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	if got, want := readUserVersion(t, db), latestVersion(t); got != want {
		t.Fatalf("user_version after fresh Open = %d, want %d", got, want)
	}

	// Sanity-check the expected schema after every migration: core tables
	// exist and 003 has folded the dossier columns into companies (and
	// dropped the dossiers table).
	for _, table := range []string{"applications", "companies", "people", "communication_threads"} {
		if _, err := db.Exec("SELECT 1 FROM " + table + " LIMIT 0"); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
	}
	if _, err := db.Exec("SELECT dossier_reasoning, company_summary FROM companies LIMIT 0"); err != nil {
		t.Fatalf("merged dossier columns missing on companies: %v", err)
	}
	if _, err := db.Exec("SELECT 1 FROM dossiers LIMIT 0"); err == nil {
		t.Fatal("dossiers table should be dropped after migration 003")
	}
}

// TestMigration004ProfileTablesAndColumns asserts the profile-side schema is
// wired up on a fresh DB: the four tables exist, the singleton profile_overview
// row is present, and the newer columns (impact on brag_entries, skills_json
// on profile_overview) are queryable.
func TestMigration004ProfileTablesAndColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.sqlite")
	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	// All four profile tables must be queryable.
	for _, table := range []string{"profile_overview", "career_sparks", "resumes", "brag_entries"} {
		if _, err := db.Exec("SELECT 1 FROM " + table + " LIMIT 0"); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
	}

	// Singleton row is seeded on migration.
	if got := queryIntTest(t, db, `SELECT COUNT(*) FROM profile_overview WHERE id = 1`); got != 1 {
		t.Fatalf("profile_overview id=1 row count = %d, want 1", got)
	}

	// Newer columns must exist.
	if _, err := db.Exec(`SELECT impact FROM brag_entries LIMIT 0`); err != nil {
		t.Fatalf("brag_entries.impact missing: %v", err)
	}
	if _, err := db.Exec(`SELECT tags_generated_at FROM brag_entries LIMIT 0`); err != nil {
		t.Fatalf("brag_entries.tags_generated_at missing: %v", err)
	}
	if _, err := db.Exec(`SELECT skills_json FROM profile_overview LIMIT 0`); err != nil {
		t.Fatalf("profile_overview.skills_json missing: %v", err)
	}

	// Confirm skills_json defaults to '[]' (not NULL) so JS parsing is safe.
	var skills string
	if err := db.QueryRow(`SELECT skills_json FROM profile_overview WHERE id = 1`).Scan(&skills); err != nil {
		t.Fatalf("select skills_json: %v", err)
	}
	if skills != "[]" {
		t.Fatalf("skills_json default = %q, want %q", skills, "[]")
	}
}

// queryIntTest is a local helper (the db_test.go file's own test helpers use
// t.Fatalf on error). Kept package-local to avoid coupling to cmd/seed.
func queryIntTest(t *testing.T, db *sql.DB, query string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return n
}

func TestOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "idem.sqlite")
	first, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	first.Close()

	second, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer second.Close()

	if got, want := readUserVersion(t, second), latestVersion(t); got != want {
		t.Fatalf("user_version after re-Open = %d, want %d", got, want)
	}
}

func TestOpenResumesFromExistingUserVersion(t *testing.T) {
	// Only meaningful if there's more than one migration to skip past.
	if latestVersion(t) < 2 {
		t.Skip("need at least 2 migrations to test resume behavior")
	}

	ms := Migrations()
	path := filepath.Join(t.TempDir(), "resume.sqlite")
	// Simulate an old install by manually applying only migration 001 —
	// don't reuse Open (which would fast-forward past v1 and destroy the
	// dossiers table that later migrations expect to exist).
	first, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	if _, err := first.Exec(ms[0].SQL); err != nil {
		t.Fatalf("apply migration 001: %v", err)
	}
	if _, err := first.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatalf("set user_version: %v", err)
	}
	first.Close()

	second, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer second.Close()

	if got, want := readUserVersion(t, second), latestVersion(t); got != want {
		t.Fatalf("user_version after resume = %d, want %d", got, want)
	}
}

func TestOpenToleratesDuplicateColumnOnLegacySnapshot(t *testing.T) {
	// Simulates a DB seeded from a pre-migrations snapshot: the full schema
	// already exists but user_version is still 0. The runner should replay
	// 001 as a no-op (all CREATE TABLE IF NOT EXISTS) and treat later
	// ALTER TABLE ADD COLUMN statements as benign duplicate-column errors
	// rather than failing the boot.
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	first, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("bootstrap Open: %v", err)
	}
	// Reset user_version to 0 while leaving the full schema in place.
	if _, err := first.Exec(`PRAGMA user_version = 0`); err != nil {
		t.Fatalf("reset user_version: %v", err)
	}
	first.Close()

	second, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("replay Open: %v", err)
	}
	defer second.Close()

	if got, want := readUserVersion(t, second), latestVersion(t); got != want {
		t.Fatalf("user_version after legacy replay = %d, want %d", got, want)
	}
}

func TestOpenRejectsEmptyPath(t *testing.T) {
	if _, err := Open(context.Background(), ""); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestIsBenignMigrationError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "duplicate column", err: errString("duplicate column name: foo"), want: true},
		{name: "mixed case", err: errString("SQL error: DUPLICATE COLUMN NAME"), want: true},
		{name: "unrelated", err: errString("no such table: bar"), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isBenignMigrationError(tc.err); got != tc.want {
				t.Fatalf("isBenignMigrationError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// errString is a trivial error type so the table above can build errors
// without pulling in errors.New for each row.
type errString string

func (e errString) Error() string { return string(e) }
