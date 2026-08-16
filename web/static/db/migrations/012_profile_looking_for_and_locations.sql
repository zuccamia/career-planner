-- Adds two job-search preference fields to profile_overview so the Discover
-- pipeline can filter by what the user actually wants:
--   looking_for    enum-ish string: internship | new_grad | full_time | contract | open
--   locations_json JSON array of target locations (strings). "Remote" entries
--                  are detected case-insensitively; when the array contains
--                  only Remote-flavored entries, the pipeline hard-filters to
--                  remote roles.
-- Both default to "no preference" (`'open'` / `'[]'`) so existing users keep
-- broad results until they opt in.

ALTER TABLE profile_overview ADD COLUMN looking_for TEXT NOT NULL DEFAULT 'open';
ALTER TABLE profile_overview ADD COLUMN locations_json TEXT NOT NULL DEFAULT '[]';
