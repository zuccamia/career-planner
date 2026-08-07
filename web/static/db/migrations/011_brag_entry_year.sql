-- Migration 011 — brag_entries.entry_date TEXT → entry_year INTEGER.
-- The UI only ever surfaced the year (see profile.mjs brag editor), and
-- existing rows were stored as YYYY-01-01 by convention. Move to a
-- first-class integer column so the schema matches the semantics and
-- avoids the datetime() ordering compromise.

ALTER TABLE brag_entries ADD COLUMN entry_year INTEGER;

UPDATE brag_entries
SET entry_year = CAST(substr(entry_date, 1, 4) AS INTEGER)
WHERE entry_date IS NOT NULL AND entry_date != '';

ALTER TABLE brag_entries DROP COLUMN entry_date;
