-- Migration 005 — add brag_entries.tags_generated_at for DBs created before
-- generated-tag timestamps were introduced. Fresh installs may already have
-- this column from 004_profile.sql; the migration runner treats duplicate
-- column errors as a benign no-op.

ALTER TABLE brag_entries ADD COLUMN tags_generated_at TEXT;