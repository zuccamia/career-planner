package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	appdb "github.com/zuccamia/career-planner/internal/db"
)

// Regression for the "sample.sqlite ended up with 100 applications" bug:
// running seed twice without -reset used to double the row count. Reset now
// defaults to true, so this test asserts that a second run leaves -count rows,
// not 2*count.
func TestSeedRunTwiceDefaultsToResetAndKeepsCountStable(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.sqlite")
	args := []string{"-db", dbPath, "-count", "3"}

	if err := run(args); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if got := countApplications(t, dbPath); got != 3 {
		t.Fatalf("after first run: applications = %d, want 3", got)
	}

	if err := run(args); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if got := countApplications(t, dbPath); got != 3 {
		t.Fatalf("after second run: applications = %d, want 3 (reset should be default)", got)
	}
}

// TestSeedAppendFlagAddsOnTop confirms the -append escape hatch still works.
func TestSeedAppendFlagAddsOnTop(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.sqlite")
	if err := run([]string{"-db", dbPath, "-count", "3"}); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := run([]string{"-db", dbPath, "-count", "3", "-append"}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	if got := countApplications(t, dbPath); got != 6 {
		t.Fatalf("applications = %d, want 6 (3 + 3 with -append)", got)
	}
}

func countApplications(t *testing.T, dbPath string) int {
	t.Helper()
	db, err := appdb.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	return queryInt(t, db, `SELECT COUNT(*) FROM applications`)
}

func queryInt(t *testing.T, db *sql.DB, query string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return n
}
