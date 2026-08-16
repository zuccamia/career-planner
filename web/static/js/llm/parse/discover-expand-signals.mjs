// JS port of internal/discover/expand.go for the BYOK-LLM path. Runs entirely
// client-side (no server round-trip). Prompt file: "discover-expand-candidates".

import { decodeJSONResponse } from '../decode.mjs';
import { sanitizeText } from '../safety.mjs';
import { buildFormatted } from '../prompts.mjs';
import { deriveLocationContext } from '../../discover/query.mjs';

const MAX_ROLE_VARIANTS = 5;
const MAX_SIGNAL_KEYWORDS = 5;

const sanitizeKeywords = (values, max) => {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    const s = (v ?? '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sanitizeText(s));
    if (out.length >= max) break;
  }
  return out;
};

// finalizeExpandSignals mirrors FinalizeExpandSignals: fall back to the raw
// headline as a single role variant if the LLM produced none.
export const finalizeExpandSignals = (out, req) => {
  const signals = {
    role_variants: sanitizeKeywords(out?.role_variants, MAX_ROLE_VARIANTS),
    signal_keywords: sanitizeKeywords(out?.signal_keywords, MAX_SIGNAL_KEYWORDS),
    broad_role: (out?.broad_role ?? '').trim(),
  };
  if (signals.role_variants.length === 0) {
    const headline = (req?.profile?.headline ?? '').trim();
    if (headline) signals.role_variants = [headline];
  }
  return signals;
};

export const parse = (raw, extras) => {
  const decoded = decodeJSONResponse(raw);
  return { signals: finalizeExpandSignals(decoded, extras?.input) };
};

// build assembles the expand-signals prompt. Input is a DiscoverRequest —
// same JSON the server /prompts/discover-expand-signals reads.
export const build = async (input, locale) => {
  const seedNames = (input.companies || [])
    .map((c) => (c?.name ?? '').trim())
    .filter(Boolean);
  const payload = {
    profile: input.profile || {},
    seed_companies: seedNames,
    brag_titles: input.brag_titles || [],
    career_sparks: input.career_sparks || [],
    employment_type: (input?.profile?.employment_type ?? '').trim(),
    location: deriveLocationContext(input?.profile?.locations || []),
  };
  return buildFormatted('discover-expand-candidates', locale, JSON.stringify(payload));
};
