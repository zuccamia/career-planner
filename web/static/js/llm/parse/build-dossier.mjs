// Ports internal/dossiers/service.go ParseAndFinalize + helpers.go
// sanitizeResult + BuildDossierPrompt + formatScrapedBlock. Produces the
// same Dossier shape the /parse/build-dossier endpoint returns
// (status="completed", plus every sanitized field).

import { decodeJSONResponse } from '../decode.mjs';
import { sanitizeText } from '../safety.mjs';
import { buildFormatted } from '../prompts.mjs';

// sanitizeParagraph collapses whitespace runs to single spaces (matches Go's
// strings.Fields + strings.Join).
const sanitizeParagraph = (v) => (v ?? '').trim().split(/\s+/).filter(Boolean).join(' ');

const sanitizeList = (values) => {
  const seen = new Set();
  const cleaned = [];
  for (const v of values ?? []) {
    const norm = sanitizeParagraph(v);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    cleaned.push(norm);
  }
  return cleaned;
};

// sanitizeProductLaunches dedupes then sorts by leading date descending. Uses
// the substring before " | " as the sort key (Go's strings.Cut behavior).
const sanitizeProductLaunches = (values) => {
  const cleaned = sanitizeList(values);
  // stable sort — the JS sort spec has been stable since ES2019.
  cleaned.sort((a, b) => {
    const ai = a.indexOf(' | ');
    const bi = b.indexOf(' | ');
    const ad = ai >= 0 ? a.slice(0, ai) : a;
    const bd = bi >= 0 ? b.slice(0, bi) : b;
    if (ad < bd) return 1;
    if (ad > bd) return -1;
    return 0;
  });
  return cleaned;
};

// sanitizeURL returns raw only if it parses with both a scheme and a host.
// Mirrors guess-candidate's careful handling — return the trimmed original
// rather than URL#href so an empty path doesn't get a spurious "/".
const sanitizeURL = (raw) => {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  let parsed;
  try { parsed = new URL(trimmed); } catch { return ''; }
  if (!parsed.protocol || !parsed.host) return '';
  return trimmed;
};

const sanitizeTechStacks = (stacks) => ({
  languages:      sanitizeList(stacks?.languages),
  frontend:       sanitizeList(stacks?.frontend),
  backend:        sanitizeList(stacks?.backend),
  infrastructure: sanitizeList(stacks?.infrastructure),
  data:           sanitizeList(stacks?.data),
  tooling:        sanitizeList(stacks?.tooling),
});

export const finalizeDossier = (generated) => ({
  status:                  'completed',
  careers_url:             sanitizeURL(generated?.careers_url),
  company_summary:         sanitizeParagraph(generated?.company_summary),
  what_the_company_does:   sanitizeParagraph(generated?.what_the_company_does),
  target_customers:        sanitizeList(generated?.target_customers),
  product_areas:           sanitizeList(generated?.product_areas),
  business_model_clues:    sanitizeList(generated?.business_model_clues),
  recent_product_launches: sanitizeProductLaunches(generated?.recent_product_launches),
  company_culture_notes:   sanitizeList(generated?.company_culture_notes),
  has_internships:         !!generated?.has_internships,
  internship_seasons:      sanitizeList(generated?.internship_seasons),
  internship_summary:      sanitizeParagraph(generated?.internship_summary),
  major_tech_stacks:       sanitizeTechStacks(generated?.major_tech_stacks),
  reasoning:               sanitizeText(sanitizeParagraph(generated?.reasoning)),
});

export const parse = (raw) => finalizeDossier(decodeJSONResponse(raw));

// Matches internal/dossiers/helpers.go ScrapedContentMaxBytes. Keeping the
// exact number here rather than fetching it — the two constants are
// deliberately duplicated so drift shows up in a review.
const SCRAPED_CONTENT_MAX_BYTES = 12000;

// truncateBytes cuts the string at n UTF-8 bytes (matching Go's byte-slice
// behavior). Multi-byte codepoints straddling the boundary are replaced
// with U+FFFD by the decoder — cosmetic tail-only loss for scraped content.
const truncateBytes = (s, n) => {
  const bytes = new TextEncoder().encode(s ?? '');
  if (bytes.length <= n) return s ?? '';
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, n));
};

// formatScrapedBlock mirrors Go's formatScrapedBlock: empty → "", else a
// labeled BEGIN/END fence with the content truncated to the byte cap.
const formatScrapedBlock = (label, raw) => {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const capped = truncateBytes(trimmed, SCRAPED_CONTENT_MAX_BYTES);
  return `\nBEGIN_UNTRUSTED_${label}\n${capped}\nEND_UNTRUSTED_${label}\n`;
};

export const build = async (input, locale) => {
  const officialName = (input?.official_name ?? '').trim();
  if (!officialName) throw new Error('official_name is required');
  return buildFormatted('build-dossier', locale,
    officialName,
    (input?.website ?? '').trim(),
    (input?.ats_url ?? '').trim(),
    (input?.ats_provider ?? '').trim(),
    formatScrapedBlock('WEBSITE_CONTENT', input?.website_content),
    formatScrapedBlock('BLOG_CONTENT',    input?.blog_content),
    formatScrapedBlock('CAREERS_CONTENT', input?.careers_content),
  );
};
