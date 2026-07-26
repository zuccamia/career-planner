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

	// Sanity-check that the migrations actually produced the expected schema:
	// each of these tables is created in 001_init.sql, and 002 adds a column
	// to dossiers. If either failed silently we'd see an error here.
	for _, table := range []string{"applications", "companies", "people", "dossiers", "communication_threads"} {
		if _, err := db.Exec("SELECT 1 FROM " + table + " LIMIT 0"); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
	}
	if _, err := db.Exec("SELECT reasoning FROM dossiers LIMIT 0"); err != nil {
		t.Fatalf("dossiers.reasoning column missing after migrations: %v", err)
	}
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

	path := filepath.Join(t.TempDir(), "resume.sqlite")
	// First Open brings the DB to the latest version.
	first, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	// Roll user_version back to 1 to simulate a DB that only applied
	// migration 001 in the past. The schema itself is a superset — 002+
	// should either no-op or hit the benign duplicate-column path.
	if _, err := first.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatalf("rollback user_version: %v", err)
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
	// (including dossiers.reasoning, which 002 adds) already exists but
	// user_version is still 0. The runner should replay 001 as a no-op (all
	// CREATE TABLE IF NOT EXISTS) and treat 002's ALTER TABLE ADD COLUMN as
	// a benign duplicate-column error rather than failing the boot.
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
