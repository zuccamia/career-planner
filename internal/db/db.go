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

	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}

	return db, nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	const schema = `
CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_name TEXT NOT NULL,
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

	if _, err := db.ExecContext(ctx, `ALTER TABLE companies ADD COLUMN tech_blog_url TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add companies.tech_blog_url column: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE dossiers ADD COLUMN recent_product_launches_json TEXT NOT NULL DEFAULT '[]'`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add dossiers.recent_product_launches_json column: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE dossiers ADD COLUMN company_culture_notes_json TEXT NOT NULL DEFAULT '[]'`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add dossiers.company_culture_notes_json column: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE dossiers ADD COLUMN has_internships INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add dossiers.has_internships column: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE dossiers ADD COLUMN internship_seasons_json TEXT NOT NULL DEFAULT '[]'`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add dossiers.internship_seasons_json column: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE dossiers ADD COLUMN internship_summary TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add dossiers.internship_summary column: %w", err)
	}

	return nil
}
