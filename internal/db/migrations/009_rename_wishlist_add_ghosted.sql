-- Migration 009 — rename application status "wishlist" to "lead" and introduce
-- "ghosted" as a distinct terminal state (silent drop-off, separate from an
-- explicit "rejected"). The enum itself lives in Go (applications.Statuses);
-- this migration only rewrites existing row values on applications and the
-- application_events history so from_status/to_status stay consistent.

UPDATE applications      SET status      = 'lead' WHERE status      = 'wishlist';
UPDATE application_events SET from_status = 'lead' WHERE from_status = 'wishlist';
UPDATE application_events SET to_status   = 'lead' WHERE to_status   = 'wishlist';
