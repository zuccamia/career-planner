package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const defaultPath = "career-planner.sqlite3"

func Open(ctx context.Context, path string) (*sql.DB, error) {
	if path == "" {
		path = defaultPath
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve db path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, fmt.Errorf("create db directory: %w", err)
	}

	db, err := sql.Open("sqlite", absPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite db: %w", err)
	}

	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("enable sqlite foreign keys: %w", err)
	}

	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}

	return db, nil
}

func ResolvePath(path string) (string, error) {
	if path == "" {
		path = defaultPath
	}
	return filepath.Abs(path)
}

func IsSafeTestPath(path string) bool {
	if path == "" {
		return false
	}
	normalized := filepath.ToSlash(path)
	return strings.Contains(normalized, "/tmp/playwright/") || strings.HasSuffix(normalized, "/tmp/playwright/test.sqlite3")
}

func Reset(ctx context.Context, path string) error {
	absPath, err := ResolvePath(path)
	if err != nil {
		return fmt.Errorf("resolve db path: %w", err)
	}
	if !IsSafeTestPath(absPath) {
		return fmt.Errorf("refusing to reset unsafe database path: %s", absPath)
	}
	database, err := Open(ctx, absPath)
	if err != nil {
		return fmt.Errorf("open database for reset: %w", err)
	}
	defer database.Close()

	statements := []string{
		`DELETE FROM engineering_blog_notes`,
		`DELETE FROM people`,
		`DELETE FROM dossiers`,
		`DELETE FROM companies`,
		`DELETE FROM sqlite_sequence WHERE name IN ('engineering_blog_notes', 'people', 'dossiers', 'companies')`,
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("reset database with %q: %w", statement, err)
		}
	}

	return nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	const schema = `
CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    official_name TEXT NOT NULL,
    website TEXT NOT NULL DEFAULT '',
    tech_blog_url TEXT NOT NULL DEFAULT '',
    ats_url TEXT NOT NULL DEFAULT '',
    ats_provider TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dossiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    careers_url TEXT NOT NULL DEFAULT '',
    company_summary TEXT NOT NULL DEFAULT '',
    what_the_company_does TEXT NOT NULL DEFAULT '',
    target_customers_json TEXT NOT NULL DEFAULT '[]',
    product_areas_json TEXT NOT NULL DEFAULT '[]',
    business_model_clues_json TEXT NOT NULL DEFAULT '[]',
    recent_product_launches_json TEXT NOT NULL DEFAULT '[]',
    company_culture_notes_json TEXT NOT NULL DEFAULT '[]',
    has_internships INTEGER NOT NULL DEFAULT 0,
    internship_seasons_json TEXT NOT NULL DEFAULT '[]',
    internship_summary TEXT NOT NULL DEFAULT '',
    major_tech_stacks_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dossiers_company_id ON dossiers(company_id);

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    company_id INTEGER,
    linkedin_url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS engineering_blog_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (company_id) REFERENCES companies(id)
);
`

	if _, err := db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate companies table: %w", err)
	}

	return nil
}
