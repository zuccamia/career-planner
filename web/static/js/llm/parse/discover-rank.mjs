// JS port of internal/discover/rank.go for the BYOK-LLM path. Runs entirely
// client-side (no server round-trip). Prompt file: "discover-rank-jobs".

import { decodeJSONResponse } from '../decode.mjs';
import { sanitizeText } from '../safety.mjs';
import { buildFormatted } from '../prompts.mjs';
import { deriveLocationContext } from '../../discover/query.mjs';
import { normalizeURL } from '../../discover/helpers.mjs';

const MIN_MATCH_SCORE = 0;
const MAX_MATCH_SCORE = 100;
const CAP_POSTING_TITLE = 200;
const CAP_POSTING_SNIPPET = 2000;
const CAP_POSTING_COMPANY = 200;
const DEFAULT_LIMIT = 5;

const truncate = (s, n) => {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n);
};

// capPostings truncates prompt-visible fields the same way rank.go does.
// board_url/provider/posted_at are not in the JobPosting JSON schema
// (json:"-" on the Go side) but the client carries them for post-parse
// re-attachment; leave them intact here.
const capPostings = (postings) => postings.map((p) => ({
  ...p,
  title: truncate(p.title, CAP_POSTING_TITLE),
  snippet: truncate(p.snippet || '', CAP_POSTING_SNIPPET),
  company: truncate(p.company || '', CAP_POSTING_COMPANY),
}));

// finalizeRank ports FinalizeRank: URL whitelist against inputs, score
// clamp, sanitize rationale, augment with provider/board_url/posted_at from
// the origin posting (the server would populate these from its in-memory
// JobPosting; we do it client-side because the JSON round-trip strips them).
export const finalizeRank = (out, postings, limit) => {
  const allowed = new Map();
  for (const p of postings || []) {
    const key = normalizeURL(p.url);
    if (key) allowed.set(key, p);
  }
  const cleaned = [];
  for (const r of out?.recommendations || []) {
    const url = (r?.url ?? '').trim();
    const title = (r?.title ?? '').trim();
    if (!url || !title) continue;
    const origin = allowed.get(normalizeURL(url));
    if (!origin) continue;
    let score = Number.isFinite(r.match_score) ? r.match_score : 0;
    if (score < MIN_MATCH_SCORE) score = MIN_MATCH_SCORE;
    if (score > MAX_MATCH_SCORE) score = MAX_MATCH_SCORE;
    const company = ((r?.company ?? '').trim()) || (origin.company || '');
    cleaned.push({
      title,
      company,
      url,
      match_score: score,
      rationale: sanitizeText(r?.rationale),
      provider: origin.provider || '',
      board_url: origin.board_url || '',
      posted_at: origin.posted_at || '',
    });
    if (cleaned.length >= limit) break;
  }
  return cleaned;
};

export const parse = (raw, extras) => {
  const decoded = decodeJSONResponse(raw);
  const limit = extras?.input?.limit > 0 ? extras.input.limit : DEFAULT_LIMIT;
  return { recommendations: finalizeRank(decoded, extras?.input?.postings || [], limit) };
};

// build assembles the rank prompt. Input: {request, postings, limit} — same
// shape /prompts/discover-rank consumes.
export const build = async (input, locale) => {
  const req = input.request || {};
  const limit = input.limit > 0 ? input.limit : DEFAULT_LIMIT;
  const payload = {
    profile: req.profile || {},
    postings: capPostings(input.postings || []),
    limit,
    employment_type: (req?.profile?.employment_type ?? '').trim(),
    location: deriveLocationContext(req?.profile?.locations || []),
  };
  return buildFormatted('discover-rank-jobs', locale, JSON.stringify(payload));
};
