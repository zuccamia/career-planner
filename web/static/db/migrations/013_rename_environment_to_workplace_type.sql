-- Migration 013 — rename profile_overview.environment to workplace_type.
-- The column stores 'remote' | 'hybrid' | 'onsite' (or '' for unset), which
-- is really the workplace-type / job-location-type concept — the previous
-- "environment" name was ambiguous with system environment. Rename brings the
-- schema in line with the LinkedIn/Google Jobs convention.

ALTER TABLE profile_overview RENAME COLUMN environment TO workplace_type;
