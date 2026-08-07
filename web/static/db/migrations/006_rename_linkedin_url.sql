-- Migration 006 — rename people.linkedin_url to social_url so the column can
-- hold any social profile link (LinkedIn, Facebook, etc.), not just LinkedIn.
-- The UI auto-detects the network from the URL host to pick an icon.

ALTER TABLE people RENAME COLUMN linkedin_url TO social_url;
