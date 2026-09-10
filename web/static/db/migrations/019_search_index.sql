-- Migration 019 — FTS5 search index for brag_entries.
-- Feeds the tool-driven tailor pipeline: the LLM issues search_brags tool
-- calls that MATCH this table in BM25 order. (search_resumes is a LIKE
-- scan over the resumes table — the corpus is too small to justify FTS.)
--
-- Contentless (`content=''`) — triggers own the sync so we can flatten
-- `tags_json` and resolve `company_id → companies.name` at write time.
--
-- Backfill is NOT self-idempotent; re-running would duplicate rows.
-- Relies on ensureSchema's user_version bookmark to run this file exactly
-- once per DB.

CREATE VIRTUAL TABLE IF NOT EXISTS brag_entries_fts USING fts5(
    title, body, impact, tags, company_name,
    content='',
    tokenize='porter unicode61'
);

-- Backfill from current rows.
INSERT INTO brag_entries_fts (rowid, title, body, impact, tags, company_name)
SELECT
    b.id,
    b.title,
    b.body,
    b.impact,
    COALESCE((SELECT group_concat(value, ' ') FROM json_each(b.tags_json)), ''),
    COALESCE(c.official_name, '')
FROM brag_entries b
LEFT JOIN companies c ON c.id = b.company_id;

-- brag_entries triggers.
CREATE TRIGGER IF NOT EXISTS brag_entries_fts_ai AFTER INSERT ON brag_entries BEGIN
    INSERT INTO brag_entries_fts (rowid, title, body, impact, tags, company_name)
    VALUES (
        NEW.id,
        NEW.title,
        NEW.body,
        NEW.impact,
        COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.tags_json)), ''),
        COALESCE((SELECT official_name FROM companies WHERE id = NEW.company_id), '')
    );
END;

CREATE TRIGGER IF NOT EXISTS brag_entries_fts_ad AFTER DELETE ON brag_entries BEGIN
    INSERT INTO brag_entries_fts (brag_entries_fts, rowid, title, body, impact, tags, company_name)
    VALUES ('delete', OLD.id, OLD.title, OLD.body, OLD.impact, '', '');
END;

CREATE TRIGGER IF NOT EXISTS brag_entries_fts_au AFTER UPDATE ON brag_entries BEGIN
    INSERT INTO brag_entries_fts (brag_entries_fts, rowid, title, body, impact, tags, company_name)
    VALUES ('delete', OLD.id, OLD.title, OLD.body, OLD.impact, '', '');
    INSERT INTO brag_entries_fts (rowid, title, body, impact, tags, company_name)
    VALUES (
        NEW.id,
        NEW.title,
        NEW.body,
        NEW.impact,
        COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.tags_json)), ''),
        COALESCE((SELECT official_name FROM companies WHERE id = NEW.company_id), '')
    );
END;

-- companies rename → refresh derived company_name for every affected brag.
CREATE TRIGGER IF NOT EXISTS brag_entries_fts_company_rename
AFTER UPDATE OF official_name ON companies
WHEN NEW.official_name IS NOT OLD.official_name
BEGIN
    INSERT INTO brag_entries_fts (brag_entries_fts, rowid, title, body, impact, tags, company_name)
    SELECT 'delete', b.id, b.title, b.body, b.impact, '', OLD.official_name
    FROM brag_entries b WHERE b.company_id = NEW.id;
    INSERT INTO brag_entries_fts (rowid, title, body, impact, tags, company_name)
    SELECT
        b.id, b.title, b.body, b.impact,
        COALESCE((SELECT group_concat(value, ' ') FROM json_each(b.tags_json)), ''),
        NEW.official_name
    FROM brag_entries b WHERE b.company_id = NEW.id;
END;

