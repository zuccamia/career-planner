package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// latestVersion returns the version of the highest-numbered migration.
func latestVersion(t *testing.T) int {
	t.Helper()
	ms := migrations()
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
	ms := migrations()
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
	db, err := openDB(context.Background(), path)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	defer db.Close()

	if got, want := readUserVersion(t, db), latestVersion(t); got != want {
		t.Fatalf("user_version after fresh openDB = %d, want %d", got, want)
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

func TestMigration004ProfileTablesAndColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.sqlite")
	db, err := openDB(context.Background(), path)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	defer db.Close()

	for _, table := range []string{"profile_overview", "career_sparks", "resumes", "brag_entries"} {
		if _, err := db.Exec("SELECT 1 FROM " + table + " LIMIT 0"); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
	}

	if got := queryIntDB(t, db, `SELECT COUNT(*) FROM profile_overview WHERE id = 1`); got != 1 {
		t.Fatalf("profile_overview id=1 row count = %d, want 1", got)
	}

	if _, err := db.Exec(`SELECT impact FROM brag_entries LIMIT 0`); err != nil {
		t.Fatalf("brag_entries.impact missing: %v", err)
	}
	if _, err := db.Exec(`SELECT tags_generated_at FROM brag_entries LIMIT 0`); err != nil {
		t.Fatalf("brag_entries.tags_generated_at missing: %v", err)
	}
	if _, err := db.Exec(`SELECT skills_json FROM profile_overview LIMIT 0`); err != nil {
		t.Fatalf("profile_overview.skills_json missing: %v", err)
	}

	var skills string
	if err := db.QueryRow(`SELECT skills_json FROM profile_overview WHERE id = 1`).Scan(&skills); err != nil {
		t.Fatalf("select skills_json: %v", err)
	}
	if skills != "[]" {
		t.Fatalf("skills_json default = %q, want %q", skills, "[]")
	}
}

// queryIntDB scans a single-int query. Named to avoid clashing with the
// queryInt helper in main_test.go, which takes a dbPath instead.
func queryIntDB(t *testing.T, db *sql.DB, query string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return n
}

func TestOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "idem.sqlite")
	first, err := openDB(context.Background(), path)
	if err != nil {
		t.Fatalf("first openDB: %v", err)
	}
	first.Close()

	second, err := openDB(context.Background(), path)
	if err != nil {
		t.Fatalf("second openDB: %v", err)
	}
	defer second.Close()

	if got, want := readUserVersion(t, second), latestVersion(t); got != want {
		t.Fatalf("user_version after re-openDB = %d, want %d", got, want)
	}
}

func TestOpenResumesFromExistingUserVersion(t *testing.T) {
	if latestVersion(t) < 2 {
		t.Skip("need at least 2 migrations to test resume behavior")
	}

	ms := migrations()
	path := filepath.Join(t.TempDir(), "resume.sqlite")
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

	second, err := openDB(context.Background(), path)
	if err != nil {
		t.Fatalf("second openDB: %v", err)
	}
	defer second.Close()

	if got, want := readUserVersion(t, second), latestVersion(t); got != want {
		t.Fatalf("user_version after resume = %d, want %d", got, want)
	}
}

func TestOpenToleratesDuplicateColumnOnLegacySnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	first, err := openDB(context.Background(), path)
	if err != nil {
		t.Fatalf("bootstrap openDB: %v", err)
	}
	if _, err := first.Exec(`PRAGMA user_version = 0`); err != nil {
		t.Fatalf("reset user_version: %v", err)
	}
	first.Close()

	second, err := openDB(context.Background(), path)
	if err != nil {
		t.Fatalf("replay openDB: %v", err)
	}
	defer second.Close()

	if got, want := readUserVersion(t, second), latestVersion(t); got != want {
		t.Fatalf("user_version after legacy replay = %d, want %d", got, want)
	}
}

func TestOpenRejectsEmptyPath(t *testing.T) {
	if _, err := openDB(context.Background(), ""); err == nil {
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
		{name: "no such column", err: errString("no such column: linkedin_url"), want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isBenignMigrationError(tc.err); got != tc.want {
				t.Fatalf("isBenignMigrationError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

type errString string

func (e errString) Error() string { return string(e) }
