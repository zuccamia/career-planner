// Ranks brag entries by JD relevance. Companion of the tailor-resume flow —
// callers use the ranking to pick the top-N brags to include in the draft.

import { decodeJSONResponse, nonNegInt, buildFormattedWithJDPersona } from '../../sources/llm/prompts.mjs';
import { sanitizeText } from '../../sources/llm/safety.mjs';
import { flattenBaseResume } from '../profile/import-resume.mjs';

const clampScore = (raw) => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
};

// Cap of 8 signals per side — brags rarely legitimately hit more; runaway
// lists mean the LLM is echoing rather than judging.
const sanitizeSignalList = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    const cleaned = sanitizeText(s ?? '');
    if (cleaned) out.push(cleaned);
    if (out.length >= 8) break;
  }
  return out;
};

const sanitizeSuggestedReplaces = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const idx = nonNegInt(raw.bullet_index);
  return idx === null ? null : { bullet_index: idx };
};

export const parse = (raw, extras = {}) => {
  const decoded = decodeJSONResponse(raw) ?? {};
  const validIds = Array.isArray(extras?.input?.brags)
    ? new Set(extras.input.brags.map((row) => nonNegInt(row?.id, 1)).filter((v) => v !== null))
    : null;
  const seen = new Set();
  const ranked = [];
  for (const entry of decoded.ranked ?? []) {
    const bragId = nonNegInt(entry?.brag_id, 1);
    if (bragId === null || seen.has(bragId)) continue;
    if (validIds && !validIds.has(bragId)) continue;
    seen.add(bragId);
    const relevance = clampScore(entry?.relevance);
    const swapPriority = clampScore(entry?.swap_priority);
    ranked.push({
      brag_id:                    bragId,
      relevance,
      swap_priority:              swapPriority,
      signals_hit:                sanitizeSignalList(entry?.signals_hit),
      signals_uncovered_by_base:  sanitizeSignalList(entry?.signals_uncovered_by_base),
      target_entry_index:         nonNegInt(entry?.target_entry_index),
      suggested_replaces:         sanitizeSuggestedReplaces(entry?.suggested_replaces),
    });
  }
  // Sort by max(swap_priority, relevance) descending — swap dominates when set,
  // otherwise relevance decides. Ties broken by relevance.
  ranked.sort((a, b) => {
    const ka = Math.max(a.swap_priority, a.relevance);
    const kb = Math.max(b.swap_priority, b.relevance);
    if (kb !== ka) return kb - ka;
    return b.relevance - a.relevance;
  });
  return { ranked };
};

export const build = async (input, locale) => {
  const jd = input?.jd_structured;
  const profile = input?.profile;
  const brags = input?.brags;
  const base = input?.base_resume_structured;
  const signals = input?.role_signals ?? '';
  if (!jd) throw new Error('jd_structured is required');
  if (!profile) throw new Error('profile is required');
  if (!base) throw new Error('base_resume_structured is required');
  if (!Array.isArray(brags) || brags.length === 0) throw new Error('brags is required');
  return buildFormattedWithJDPersona('applications/tailor-rank-brags', locale, jd,
    signals,
    JSON.stringify(jd),
    JSON.stringify(profile),
    flattenBaseResume(base),
    JSON.stringify(brags),
  );
};
