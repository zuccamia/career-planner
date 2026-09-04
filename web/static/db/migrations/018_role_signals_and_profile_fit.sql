-- Migration 018 — rename `tailor_signals` to `role_signals` and add
-- `profile_fit`.
--
-- The column previously named `tailor_signals` caches the analyze-role-signals
-- LLM output; the "tailor" prefix leaked implementation from the caller (the
-- tailor pipeline) into the storage layer. `role_signals` names what it
-- actually holds: the role-side rubric (skills, traits, resonant stories,
-- ATS keywords).
--
-- `profile_fit` caches the candidate-side fit analysis (strengths, gaps,
-- adjacent experience, positioning) derived by analyze-fit — which reads the
-- role_signals rubric above (not the raw JD) plus the user's profile and
-- brag entries.

ALTER TABLE applications RENAME COLUMN tailor_signals TO role_signals;
ALTER TABLE applications ADD COLUMN profile_fit TEXT NOT NULL DEFAULT '';
