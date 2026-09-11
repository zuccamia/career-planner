// Tailors a base résumé for one job posting. Output is the same
// ResumeStructured shape profile/import-resume emits, plus a
// `changes[]` audit trail: one entry per bullet/description whose text
// differs from the base, with citations tying the change back to role_signals.

import { decodeJSONResponse, nonNegInt, buildFormattedWithJDPersona } from '../../sources/llm/prompts.mjs';
import { sanitizeText } from '../../sources/llm/safety.mjs';
import { finalizeImportResume } from '../profile/import-resume.mjs';

// Must match bulletWordCap in internal/applications/tailor.go so the LLM
// sees the same soft limit on both paths.
export const BULLET_WORD_CAP = 40;

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

// Returns { clean, reason }: clean is the sanitized entry when accepted;
// reason is a stable enum matching internal/applications/service.go so both
// paths render the same UI labels. `before` is derived from the base — the
// LLM only supplies `after`, index, brag_id, citations, reasoning.
const sanitizeChange = (raw, base) => {
  if (!raw || typeof raw !== 'object') return { clean: null, reason: 'invalid_index' };
  if (!CHANGE_SECTIONS.has(raw.section)) return { clean: null, reason: 'invalid_index' };
  const entryIndex = nonNegInt(raw.entry_index);
  if (entryIndex === null) return { clean: null, reason: 'invalid_index' };
  const bulletIndex = nonNegInt(raw.bullet_index);
  const baseText = baseTextAt(raw.section, entryIndex, bulletIndex, base);
  if (baseText === null) return { clean: null, reason: 'invalid_index' };
  const before = String(baseText).trim();
  const after = sanitizeText(raw.after ?? '');
  if (!after || before === after) return { clean: null, reason: 'empty_or_noop' };
  const bragID = Number.isInteger(Number(raw.brag_id)) && Number(raw.brag_id) > 0
    ? Number(raw.brag_id) : 0;
  return {
    clean: {
      section: raw.section,
      entry_index: entryIndex,
      bullet_index: bulletIndex,
      before,
      after,
      brag_id: bragID,
      citations: sanitizeCitations(raw.citations),
      reasoning: sanitizeText(raw.reasoning ?? ''),
    },
    reason: null,
  };
};

export const parse = (raw, { base = null } = {}) => {
  const decoded = decodeJSONResponse(raw) ?? {};
  const changes = [];
  const rejected_changes = [];
  for (const entry of decoded.changes ?? []) {
    const { clean, reason } = sanitizeChange(entry, base);
    if (clean) changes.push(clean);
    else rejected_changes.push({ raw: entry, reason });
  }
  const resume = finalizeImportResume(decoded.resume ?? {});
  return { changes, rejected_changes, resume };
};

export const build = async (input, locale) => {
  const jd = input?.jd_structured;
  const profile = input?.profile;
  const base = input?.base_resume_structured;
  const signals = input?.role_signals ?? '';
  const fit = input?.profile_fit ?? '';
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
    fit,
    JSON.stringify(profile),
    JSON.stringify(base),
    JSON.stringify(experienceBrags),
    JSON.stringify(projectBrags),
    JSON.stringify(activityBrags),
  );
};

