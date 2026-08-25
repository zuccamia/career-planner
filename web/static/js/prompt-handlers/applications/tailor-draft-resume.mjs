// Tailors a base résumé for one job posting. Output is the same
// ResumeStructured shape profile/import-resume emits, plus a
// `changes[]` audit trail: one entry per bullet/description whose text
// differs from the base, with citations tying the change back to role_signals.

import { decodeJSONResponse, nonNegInt, buildFormattedWithJDPersona } from '../../sources/llm/prompts.mjs';
import { sanitizeText } from '../../sources/llm/safety.mjs';
import { finalizeImportResume } from '../profile/import-resume.mjs';

// Must match bulletWordCap in internal/applications/tailor.go so the LLM
// sees the same soft limit on both paths.
const BULLET_WORD_CAP = 40;

const CHANGE_SECTIONS = new Set(['experience', 'projects', 'activities']);

const sanitizeCitations = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const cite of raw) {
    const cleaned = sanitizeText(cite ?? '');
    if (cleaned) out.push(cleaned);
    if (out.length >= 3) break;
  }
  return out;
};

// baseTextAt returns the base résumé's text at (section, entry, bullet).
// Assumes indices are valid.
const baseTextAt = (section, entryIndex, bulletIndex, base) => {
  if (!base) return null;
  if (section === 'experience') return base.experience?.[entryIndex]?.bullets?.[bulletIndex]?.description ?? null;
  if (section === 'projects')   return base.projects?.[entryIndex]?.description ?? null;
  if (section === 'activities') return base.activities?.[entryIndex]?.description ?? null;
  return null;
};

const sanitizeChange = (raw, base) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!CHANGE_SECTIONS.has(raw.section)) return null;
  const entryIndex = nonNegInt(raw.entry_index);
  if (entryIndex === null) return null;
  const bulletIndex = nonNegInt(raw.bullet_index);
  const before = sanitizeText(raw.before ?? '');
  const after = sanitizeText(raw.after ?? '');
  if (!before || !after || before === after) return null;
  // Drop if `before` doesn't match the base text at that position — guards
  // against LLM hallucinating a base line that never existed.
  if (base) {
    const expected = baseTextAt(raw.section, entryIndex, bulletIndex, base);
    if (expected === null || String(expected).trim() !== before) return null;
  }
  const bragID = Number.isInteger(Number(raw.brag_id)) && Number(raw.brag_id) > 0
    ? Number(raw.brag_id) : 0;
  return {
    section: raw.section,
    entry_index: entryIndex,
    bullet_index: bulletIndex,
    before,
    after,
    brag_id: bragID,
    citations: sanitizeCitations(raw.citations),
    reasoning: sanitizeText(raw.reasoning ?? ''),
  };
};

export const parse = (raw, { base = null } = {}) => {
  const decoded = decodeJSONResponse(raw) ?? {};
  const changes = [];
  for (const entry of decoded.changes ?? []) {
    const cleaned = sanitizeChange(entry, base);
    if (cleaned) changes.push(cleaned);
  }
  const resume = finalizeImportResume(decoded.resume ?? {});
  return { changes, resume };
};

export const build = async (input, locale) => {
  const jd = input?.jd_structured;
  const profile = input?.profile;
  const base = input?.base_resume_structured;
  const signals = input?.role_signals ?? '';
  const experienceBrags = input?.experience_brags ?? [];
  const projectBrags = input?.project_brags ?? [];
  const activityBrags = input?.activity_brags ?? [];
  if (!jd) throw new Error('jd_structured is required');
  if (!profile) throw new Error('profile is required');
  if (!base) throw new Error('base_resume_structured is required');
  if (!Array.isArray(experienceBrags) || !Array.isArray(projectBrags) || !Array.isArray(activityBrags)) {
    throw new Error('experience_brags, project_brags, and activity_brags must be arrays');
  }
  return buildFormattedWithJDPersona('applications/tailor-draft-resume', locale, jd,
    String(BULLET_WORD_CAP),
    signals,
    JSON.stringify(jd),
    JSON.stringify(profile),
    JSON.stringify(base),
    JSON.stringify(experienceBrags),
    JSON.stringify(projectBrags),
    JSON.stringify(activityBrags),
  );
};

