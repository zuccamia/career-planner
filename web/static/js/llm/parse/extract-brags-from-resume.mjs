// Ports internal/brags/service.go: FinalizeExtracted + BuildExtractFromResumePrompt.

import { decodeJSONResponse } from '../decode.mjs';
import { isSuspiciousText } from '../safety.mjs';
import { buildFromField } from '../prompts.mjs';
import { finalizeTags } from './generate-brag-tags.mjs';

const clampConfidence = (v) => {
  const n = typeof v === 'number' ? v : 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

// finalizeExtracted trims fields, drops empty-title/suspicious entries,
// clamps confidence to [0,1], and dedupes on a normalized (title, body) key.
export const finalizeExtracted = (out) => {
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
    const key = (title + ' ' + body).trim().split(/\s+/).join(' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // company + entry_year use omitempty on the Go side — mirror that so
    // the shape matches the /parse endpoint response.
    const entry = {
      title,
      body,
      impact,
      tags: finalizeTags({ tags: raw.tags ?? [] }),
      confidence: clampConfidence(raw.confidence),
    };
    if (company) entry.company = company;
    if (entryYear !== null) entry.entry_year = entryYear;
    entries.push(entry);
  }
  return entries;
};

export const parse = (raw) => ({ brags: finalizeExtracted(decodeJSONResponse(raw)) });

export const build = async (input, locale) => buildFromField('extract-brags-from-resume', input, 'markdown', locale);
