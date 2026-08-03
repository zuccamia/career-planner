-- Migration 010 — profile wizard revamp: environment, tools list, and
-- wizard resume progress blob on profile_overview.

ALTER TABLE profile_overview ADD COLUMN environment TEXT NOT NULL DEFAULT '';
ALTER TABLE profile_overview ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profile_overview ADD COLUMN wizard_progress TEXT;
