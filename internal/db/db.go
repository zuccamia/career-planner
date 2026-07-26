package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// migrationFiles embeds every SQL file under migrations/. Each file is one
// forward step and its numeric prefix (001_, 002_, …) determines order.
//
//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migration is one ordered step. Both the Go migrate loop and the browser
// client apply these in ascending Version order, tracking progress via SQLite's
// PRAGMA user_version.
type Migration struct {
	Version int    `json:"version"`
	Name    string `json:"name"`
	SQL     string `json:"sql"`
}

var (
	migrations      []Migration
	migrationFileRe = regexp.MustCompile(`^(\d+)_([^./]+)\.sql$`)
)

func init() {
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		panic(fmt.Errorf("load migrations dir: %w", err))
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := migrationFileRe.FindStringSubmatch(entry.Name())
		if match == nil {
			panic(fmt.Errorf("migration filename %q does not match NNN_name.sql", entry.Name()))
		}
		version, err := strconv.Atoi(match[1])
		if err != nil {
			panic(fmt.Errorf("parse migration version %q: %w", entry.Name(), err))
		}
		body, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			panic(fmt.Errorf("read migration %q: %w", entry.Name(), err))
		}
		migrations = append(migrations, Migration{
			Version: version,
			Name:    match[2],
			SQL:     string(body),
		})
	}
	sort.Slice(migrations, func(i, j int) bool { return migrations[i].Version < migrations[j].Version })

	// Guard against gaps or duplicates so the ordering matches the browser side.
	for i, m := range migrations {
		if m.Version != i+1 {
			panic(fmt.Errorf("migration versions must be sequential from 1; got %d at position %d", m.Version, i+1))
		}
	}
}

// Migrations returns the ordered migration list, safe for callers to serialize
// (the underlying slice is not mutated after init).
func Migrations() []Migration {
	return migrations
}

// Open creates or opens a SQLite database at path and brings its schema up to
// the latest migration. Used by cmd/seed to regenerate the checked-in sample
// dataset; the server itself no longer opens a database at runtime.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	if path == "" {
		return nil, fmt.Errorf("db path is required")
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

func migrate(ctx context.Context, db *sql.DB) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var current int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&current); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	for _, m := range migrations {
		if m.Version <= current {
			continue
		}
		if _, err := db.ExecContext(ctx, m.SQL); err != nil && !isBenignMigrationError(err) {
			return fmt.Errorf("apply migration %03d_%s: %w", m.Version, m.Name, err)
		}
		if _, err := db.ExecContext(ctx, fmt.Sprintf(`PRAGMA user_version = %d`, m.Version)); err != nil {
			return fmt.Errorf("set user_version %d: %w", m.Version, err)
		}
	}
	return nil
}

// isBenignMigrationError treats "duplicate column" as a no-op so an ADD COLUMN
// migration succeeds against DBs that already had the column (e.g. installs
// created from a snapshot that predates versioned migrations).
func isBenignMigrationError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate column")
}
