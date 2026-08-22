-- Migration 016 — cache the AI-derived role brief per application.
-- The tailor pipeline now first analyzes JD + company dossier into a
-- "role brief" (skills / traits / experiences / stories that resonate).
-- Persisted so subsequent tailors reuse it without another LLM call, and
-- so the insight is preserved for the user even if they abandon a tailor.
-- Free-form markdown (not JSON) — the brief feeds prompts and the UI as-is.

ALTER TABLE applications ADD COLUMN tailor_signals TEXT NOT NULL DEFAULT '';
