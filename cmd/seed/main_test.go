package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
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

// TestSeedProfileWritesOverviewSparksResumesAndBrags exercises the profile
// half of the seed — the applications-focused tests above wouldn't catch a
// regression like "seedProfile silently no-ops" or "impact column stopped
// being populated." Confirms the shape of the seeded profile section.
func TestSeedProfileWritesOverviewSparksResumesAndBrags(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "profile-seed.sqlite")
	if err := run([]string{"-db", dbPath, "-count", "3"}); err != nil {
		t.Fatalf("run: %v", err)
	}

	db, err := openDB(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	// Overview row is populated (not the default empty values). Skills JSON
	// must decode to a non-empty array; onboarded_at must be set so the
	// wizard doesn't reappear after Load-sample-data.
	var name, headline, skillsJSON string
	var onboardedAt sql.NullString
	if err := db.QueryRow(`
		SELECT name, headline, skills_json, onboarded_at
		FROM profile_overview WHERE id = 1`).Scan(&name, &headline, &skillsJSON, &onboardedAt); err != nil {
		t.Fatalf("select profile_overview: %v", err)
	}
	if name != "Nova Hoang" {
		t.Errorf("profile_overview.name = %q, want %q", name, "Nova Hoang")
	}
	if headline == "" {
		t.Errorf("profile_overview.headline is empty")
	}
	if !strings.HasPrefix(skillsJSON, "[") || len(skillsJSON) < 3 {
		t.Errorf("profile_overview.skills_json = %q, want a non-empty JSON array", skillsJSON)
	}
	if !onboardedAt.Valid || onboardedAt.String == "" {
		t.Errorf("profile_overview.onboarded_at is not set; wizard would reappear")
	}

	// Fixture counts — bumping these means the sample changed intentionally,
	// so the test doubles as a canary for accidental fixture regressions.
	if got := queryInt(t, db, `SELECT COUNT(*) FROM career_sparks`); got != 6 {
		t.Errorf("career_sparks count = %d, want 6", got)
	}
	if got := queryInt(t, db, `SELECT COUNT(*) FROM resumes`); got != 2 {
		t.Errorf("resumes count = %d, want 2", got)
	}
	if got := queryInt(t, db, `SELECT COUNT(*) FROM brag_entries`); got != 3 {
		t.Errorf("brag_entries count = %d, want 3", got)
	}

	// Sparks span at least two priority tiers (so top-tier highlighting has
	// something to lift in the UI).
	if got := queryInt(t, db, `SELECT COUNT(DISTINCT sort_order) FROM career_sparks`); got < 2 {
		t.Errorf("distinct spark priorities = %d, want >= 2", got)
	}

	// Both resume formats present.
	if got := queryInt(t, db, `SELECT COUNT(*) FROM resumes WHERE format = 'md'`); got == 0 {
		t.Error("no markdown resume seeded")
	}
	if got := queryInt(t, db, `SELECT COUNT(*) FROM resumes WHERE format = 'typ'`); got == 0 {
		t.Error("no Typst resume seeded")
	}
	if got := queryInt(t, db, `SELECT COUNT(*) FROM resumes WHERE is_primary = 1`); got != 1 {
		t.Errorf("primary resumes = %d, want exactly 1", got)
	}

	// Every seeded brag has a non-empty impact — the whole point of
	// introducing the column was to keep this signal structured.
	if got := queryInt(t, db, `SELECT COUNT(*) FROM brag_entries WHERE impact = ''`); got != 0 {
		t.Errorf("%d brag entries have empty impact; expected all seeded rows to set it", got)
	}
}

// TestSeedResetsProfileBetweenRuns confirms the -reset default also wipes
// profile fixtures, so re-running seed produces the same row counts (not
// double). Mirrors the applications-side regression test.
func TestSeedResetsProfileBetweenRuns(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "profile-reset.sqlite")
	args := []string{"-db", dbPath, "-count", "3"}
	if err := run(args); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := run(args); err != nil {
		t.Fatalf("second run: %v", err)
	}

	db, err := openDB(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if got := queryInt(t, db, `SELECT COUNT(*) FROM career_sparks`); got != 6 {
		t.Errorf("career_sparks after two runs = %d, want 6 (reset should be default)", got)
	}
	if got := queryInt(t, db, `SELECT COUNT(*) FROM resumes`); got != 2 {
		t.Errorf("resumes after two runs = %d, want 2", got)
	}
	if got := queryInt(t, db, `SELECT COUNT(*) FROM brag_entries`); got != 3 {
		t.Errorf("brag_entries after two runs = %d, want 3", got)
	}
}

func countApplications(t *testing.T, dbPath string) int {
	t.Helper()
	db, err := openDB(context.Background(), dbPath)
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
