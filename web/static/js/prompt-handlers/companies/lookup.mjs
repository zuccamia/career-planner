// Ports internal/companies/candidate.go: FinalizeCandidate + sanitizeCandidate.
// The BYOK browser path decodes the model response then calls parse() below
// to reach the same shape /api/llm/parse/companies/lookup returns on the
// server.

import { decodeJSONResponse, buildFromField } from '../../sources/llm/prompts.mjs';
import { sanitizeText } from '../../sources/llm/safety.mjs';

// sanitizeHTTPURL returns the trimmed input if it parses as an http(s) URL
// with a non-empty host. Returns the trimmed original rather than URL#href
// because JS's WHATWG URL adds a trailing slash for empty paths — Go's
// url.String() does not, and the /parse endpoint must produce identical
// output on both sides.
const sanitizeHTTPURL = (raw) => {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (!parsed.host) return '';
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return '';
  return trimmed;
};

const sanitizeCandidate = (candidate, fallbackName) => ({
  official_name: (candidate.official_name ?? '').trim() || fallbackName,
  website:       sanitizeHTTPURL(candidate.website),
  blog_url:      sanitizeHTTPURL(candidate.blog_url),
  ats_url:       sanitizeHTTPURL(candidate.ats_url),
  ats_provider:  (candidate.ats_provider ?? '').trim(),
  reasoning:     sanitizeText(candidate.reasoning),
});

export const finalizeLookup = (candidate, input) => {
  const trimmed = (input ?? '').trim();
  return sanitizeCandidate(candidate, trimmed);
};

// parse mirrors the server's rpcBYOKParse case "companies/lookup".
export const parse = (raw, input) => {
  const decoded = decodeJSONResponse(raw);
  const candidate = finalizeLookup(decoded, input?.name ?? '');
  return { candidate };
};

export const build = async (input, locale) => buildFromField('companies/lookup', input, 'name', locale);
