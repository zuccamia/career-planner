// Analyzes JD + optional company dossier into "role signals" — narrative
// markdown (skills / traits / stories / notes) plus a separate ATS-keyword
// array feed rank + tailor. Splitting them keeps the keyword list
// machine-readable for coverage checks and lets the LLM keep the markdown
// focused on human-readable synthesis.

import { decodeJSONResponse } from '../decode.mjs';
import { sanitizeText } from '../safety.mjs';
import { buildFormatted } from '../prompts.mjs';

// dedupeATSKeywords collapses case-insensitive duplicates while preserving
// the first-seen casing and order. The LLM sometimes emits both
// "PostgreSQL" and "postgresql"; keep the first.
const dedupeATSKeywords = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const term of raw) {
    const cleaned = sanitizeText(term ?? '');
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
};

export const parse = (raw) => {
  const decoded = decodeJSONResponse(raw) ?? {};
  return {
    signals: sanitizeText(decoded.signals ?? ''),
    ats_keywords: dedupeATSKeywords(decoded.ats_keywords),
  };
};

export const build = async (input, locale) => {
  const jd = input?.jd_structured;
  if (!jd) throw new Error('jd_structured is required');
  return buildFormatted('analyze-role-signals', locale,
    JSON.stringify(jd),
    JSON.stringify(input?.company_dossier ?? null),
  );
};
