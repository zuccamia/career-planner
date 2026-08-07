-- Migration 004 — career profile: overview, sparks, resumes, brag entries.
-- Compiled PDFs reuse the existing `attachments` table by inserting one row
-- per relationship (application + resume) pointing at the same on-disk file.

CREATE TABLE IF NOT EXISTS profile_overview (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT '',
    headline TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    -- JSON array of skill strings. Structured (separate from summary) so
    -- the LLM / future RAG pipeline can treat skills as a distinct signal.
    skills_json TEXT NOT NULL DEFAULT '[]',
    onboarded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO profile_overview (id) VALUES (1);

CREATE TABLE IF NOT EXISTS career_sparks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_career_sparks_sort ON career_sparks(sort_order);

CREATE TABLE IF NOT EXISTS resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'md',
    body TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_resumes_is_primary ON resumes(is_primary);

CREATE TABLE IF NOT EXISTS brag_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    -- Freeform quantitative outcome ("Cut latency 40%"), stored separately
    -- from body so the LLM / future RAG pipeline can treat metrics as a
    -- distinct signal when tailoring.
    impact TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    tags_generated_at TEXT,
    company_id INTEGER,
    entry_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_brag_entries_company ON brag_entries(company_id);
