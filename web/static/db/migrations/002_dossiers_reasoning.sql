-- Migration 002 — add dossiers.reasoning for DBs created before column existed.
-- Fresh installs already have this column from 001; the migration runner treats
-- "duplicate column" as a no-op so this is safe for both old and new DBs.

ALTER TABLE dossiers ADD COLUMN reasoning TEXT NOT NULL DEFAULT '';
