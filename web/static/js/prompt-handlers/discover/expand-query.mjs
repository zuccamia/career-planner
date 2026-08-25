// JS port of internal/discover/expand.go for the BYOK-LLM path. Runs entirely
// client-side (no server round-trip). Prompt file: "discover/expand-query".

import { decodeJSONResponse, buildFormatted } from '../../sources/llm/prompts.mjs';
import { sanitizeText } from '../../sources/llm/safety.mjs';
import { deriveLocationContext } from '../../clients/discover/helpers.mjs';

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

// finalizeExpandQuery mirrors applyHeadlineFallback: fall back to the raw
// headline as a single role variant if the LLM produced none.
export const finalizeExpandQuery = (out, req) => {
  const query = {
    role_variants: sanitizeKeywords(out?.role_variants, MAX_ROLE_VARIANTS),
    signal_keywords: sanitizeKeywords(out?.signal_keywords, MAX_SIGNAL_KEYWORDS),
    broad_role: (out?.broad_role ?? '').trim(),
  };
  if (query.role_variants.length === 0) {
    const headline = (req?.profile?.headline ?? '').trim();
    if (headline) query.role_variants = [headline];
  }
  return query;
};

export const parse = (raw, extras) => {
  const decoded = decodeJSONResponse(raw);
  return { query: finalizeExpandQuery(decoded, extras?.input) };
};

// build assembles the expand-query prompt. Input is a DiscoverRequest —
// same JSON the server /prompts/discover/expand-query reads.
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
  return buildFormatted('discover/expand-query', locale, JSON.stringify(payload));
};
