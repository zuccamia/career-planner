-- Migration 008 — drop the engineering_blog_notes table. The browser side
-- never shipped a CRUD UI for it; the dashboard's "blog notes" activity
-- series and the companies-list blog-count pill were the only readers, and
-- both are being removed alongside this table.

DROP TABLE IF EXISTS engineering_blog_notes;
