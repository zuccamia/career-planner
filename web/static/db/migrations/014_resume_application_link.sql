-- Migration 014 — link résumés to applications.
-- Tailored résumés are generated against a specific application (see
-- docs/plans/tailored-resume.md). The link is nullable so ordinary "stock"
-- résumés stay unaffected, and ON DELETE SET NULL — deleting an application
-- must not destroy the tailored draft written for it; the résumé becomes a
-- regular row the user can still edit or reattach elsewhere.

ALTER TABLE resumes ADD COLUMN application_id INTEGER
  REFERENCES applications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_resumes_application_id
  ON resumes(application_id) WHERE application_id IS NOT NULL;
