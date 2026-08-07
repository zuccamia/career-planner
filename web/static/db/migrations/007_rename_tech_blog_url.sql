-- Migration 007 — rename companies.tech_blog_url to blog_url so the column can
-- hold any company-authored publication link (engineering blog, research/
-- insights hub, or newsroom), not just tech blogs.

ALTER TABLE companies RENAME COLUMN tech_blog_url TO blog_url;
