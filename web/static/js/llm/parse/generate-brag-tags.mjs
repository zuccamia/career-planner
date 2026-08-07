// Ports internal/brags/service.go: FinalizeTags + BuildGenerateTagsPrompt.

import { decodeJSONResponse } from '../decode.mjs';
import { isSuspiciousText } from '../safety.mjs';
import { buildFromField } from '../prompts.mjs';

// finalizeTags trims, deduplicates, and caps at 7 tags. Preserves the Go
// behavior of collapsing whitespace runs and sorting the final list.
export const finalizeTags = (out) => {
  const seen = new Set();
  const tags = [];
  for (const raw of out?.tags ?? []) {
    const tag = (raw ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
    if (!tag || isSuspiciousText(tag) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === 7) break;
  }
  tags.sort();
  return tags;
};

export const parse = (raw) => ({ tags: finalizeTags(decodeJSONResponse(raw)) });

export const build = async (input, locale) => buildFromField('generate-brag-tags', input, 'body', locale);
