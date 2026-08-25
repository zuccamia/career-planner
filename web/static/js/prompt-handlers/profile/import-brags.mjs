// Ports internal/profile/service.go: finalizeImportedBrags + ImportBrags prompt.

import { decodeJSONResponse, buildFromField } from '../../sources/llm/prompts.mjs';
import { isSuspiciousText } from '../../sources/llm/safety.mjs';
import { coerceCategory } from '../../entities/profile.mjs';
import { finalizeBragTags } from './generate-brag-tags.mjs';

const clampConfidence = (v) => {
  const n = typeof v === 'number' ? v : 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

// finalizeImportedBrags trims fields, drops empty-title/suspicious entries,
// clamps confidence to [0,1], and dedupes on a normalized (title, body) key.
export const finalizeImportedBrags = (out) => {
  const entries = [];
  const seen = new Set();
  for (const raw of out?.brags ?? []) {
    const title = (raw.title ?? '').trim();
    const body  = (raw.body ?? '').trim();
    if (!title || isSuspiciousText(title) || isSuspiciousText(body)) continue;
    let impact = (raw.impact ?? '').trim();
    if (isSuspiciousText(impact)) impact = '';
    let company = (raw.company ?? '').trim();
    if (isSuspiciousText(company)) company = '';
    let entryYear = null;
    if (typeof raw.entry_year === 'number' && raw.entry_year >= 1970 && raw.entry_year <= 2100) {
      entryYear = raw.entry_year;
    }
    const category = coerceCategory(raw.category);
    const key = (title + ' ' + body).trim().split(/\s+/).join(' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // company + entry_year use omitempty on the Go side — mirror that.
    const entry = {
      title,
      body,
      impact,
      tags: finalizeBragTags({ tags: raw.tags ?? [] }),
      category,
      confidence: clampConfidence(raw.confidence),
    };
    if (company) entry.company = company;
    if (entryYear !== null) entry.entry_year = entryYear;
    entries.push(entry);
  }
  return entries;
};

export const parse = (raw) => ({ brags: finalizeImportedBrags(decodeJSONResponse(raw)) });

export const build = async (input, locale) => buildFromField('profile/import-brags', input, 'markdown', locale);
