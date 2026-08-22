-- Migration 017 — covering index for the status_since subquery used by
-- listApplications / listApplicationsByCompany. Both queries compute
-- MAX(occurred_at) filtered by (application_id, type='status_changed',
-- to_status = <current status>). The existing (application_id)-only index
-- forces a filter step; this composite is a direct seek + tail read.

CREATE INDEX IF NOT EXISTS idx_application_events_status_since
  ON application_events(application_id, type, to_status, occurred_at);
