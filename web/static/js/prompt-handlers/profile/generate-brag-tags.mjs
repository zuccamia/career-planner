// Ports internal/profile/service.go: finalizeBragTags + GenerateBragTags prompt.

import { decodeJSONResponse, buildFromField } from '../../sources/llm/prompts.mjs';
import { isSuspiciousText } from '../../sources/llm/safety.mjs';

// finalizeBragTags trims, deduplicates, and caps at 7 tags. Preserves the Go
// behavior of collapsing whitespace runs and sorting the final list.
export const finalizeBragTags = (out) => {
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

export const parse = (raw) => ({ tags: finalizeBragTags(decodeJSONResponse(raw)) });

export const build = async (input, locale) => buildFromField('profile/generate-brag-tags', input, 'body', locale);
