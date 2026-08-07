package main

// SQLite bootstrap for the seed pipeline. The runtime server does not open
// a database — the browser owns it — so this file lives with the only Go
// consumer that still needs one (cmd/seed, which builds the checked-in
// sample dataset).

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// migrationsDir resolves web/static/db/migrations relative to the repo root,
// found by walking up from this source file until we hit go.mod. Lets both
// `go run ./cmd/seed` (from repo root) and `go test ./cmd/seed/...` (from
// the package dir) find the SQL files without a CWD-dependent path.
var migrationsDir = findRepoPath("web", "static", "db", "migrations")

func findRepoPath(parts ...string) string {
	_, this, _, ok := runtime.Caller(0)
	if !ok {
		panic("runtime.Caller failed")
	}
	dir := filepath.Dir(this)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return filepath.Join(append([]string{dir}, parts...)...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			panic("go.mod not found walking up from " + this)
		}
		dir = parent
	}
}

type Migration struct {
	Version int
	Name    string
	SQL     string
}

var migrationFileRe = regexp.MustCompile(`^(\d+)_([^./]+)\.sql$`)

// migrations returns the ordered migration list, memoized after the first
// call. Panics on filename/version irregularities so seed builds fail loud
// rather than silently skipping steps.
var migrations = sync.OnceValue(func() []Migration {
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		panic(fmt.Errorf("load migrations dir %s: %w", migrationsDir, err))
	}
	out := make([]Migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
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
		body, err := os.ReadFile(filepath.Join(migrationsDir, entry.Name()))
		if err != nil {
			panic(fmt.Errorf("read migration %q: %w", entry.Name(), err))
		}
		out = append(out, Migration{Version: version, Name: match[2], SQL: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	for i, m := range out {
		if m.Version != i+1 {
			panic(fmt.Errorf("migration versions must be sequential from 1; got %d at position %d", m.Version, i+1))
		}
	}
	return out
})

// openDB creates or opens a SQLite database at path and brings its schema
// up to the latest migration.
func openDB(ctx context.Context, path string) (*sql.DB, error) {
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
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var current int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&current); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	for _, m := range migrations() {
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

// isBenignMigrationError treats "duplicate column" and "no such column" as
// no-ops so ADD COLUMN and RENAME COLUMN migrations succeed against DBs that
// already reflect the target schema.
func isBenignMigrationError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate column") || strings.Contains(msg, "no such column")
}
