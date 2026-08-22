-- Migration 015 — categorize brag entries by résumé section.
-- The tailor flow needs to route brags into the right résumé section:
-- experience bullets, projects, or interests/activities. Existing rows
-- default to 'experience' — the historical use case. Users re-categorize
-- from the brag editor.

ALTER TABLE brag_entries ADD COLUMN category TEXT NOT NULL DEFAULT 'experience'
  CHECK (category IN ('experience', 'project', 'activity'));

CREATE INDEX IF NOT EXISTS idx_brag_entries_category ON brag_entries(category);
