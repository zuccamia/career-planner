// Ports internal/communications/service.go: FinalizeSummary +
// BuildSummaryPrompt + buildThreadContext + entryActorLabel.

import { decodeJSONResponse } from '../decode.mjs';
import { sanitizeText } from '../safety.mjs';
import { buildFormatted } from '../prompts.mjs';

export const finalizeSummary = (out) => sanitizeText(out?.summary);

export const parse = (raw) => ({ summary: finalizeSummary(decodeJSONResponse(raw)) });

const ALLOWED_DIRECTIONS = new Set(['inbound', 'outbound', 'note']);

// entryActorLabel mirrors Go's entryActorLabel — resolves the direction token
// into human-readable attribution the LLM can copy verbatim.
const entryActorLabel = (direction, personName) => {
  const d = (direction ?? '').trim().toLowerCase();
  const dir = ALLOWED_DIRECTIONS.has(d) ? d : 'note';
  if (dir === 'inbound')  return `from ${personName} to me`;
  if (dir === 'outbound') return `from me to ${personName}`;
  return `my personal note (NOT sent to ${personName}, NOT sent to anyone)`;
};

// formatOccurredAt parses "YYYY-MM-DD HH:MM:SS" or any Date-parseable string
// and emits Go time.RFC3339 in UTC (no milliseconds) so the assembled
// context is identical to what the server produces.
const formatOccurredAt = (raw) => {
  const s = (raw ?? '').trim();
  if (!s) return '0001-01-01T00:00:00Z'; // Go's zero-time RFC3339 output.
  // SQLite fallback: "YYYY-MM-DD HH:MM:SS" — Date parses it as local. Match
  // Go's rpc.go behavior which does the same via time.Parse("...", s).
  let d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '0001-01-01T00:00:00Z';
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

// buildThreadContext ports internal/communications/service.go. Channel and
// Status are sanitized (same rationale as the Go side): the values are
// expected to be enum tokens from the browser dropdown, so any suspicious
// content there is bogus and collapses to empty rather than reaching the LLM.
export const buildThreadContext = (detail) => {
  const thread = detail?.thread ?? {};
  const personName = (thread.person_name ?? '').trim() || 'the person';
  const parts = [
    `Person: ${personName}`,
    `Channel: ${sanitizeText(thread.channel)}`,
    `Subject: ${thread.subject ?? ''}`,
    `Status: ${sanitizeText(thread.status)}`,
    'Entry order: newest first.',
  ];
  const notes = (thread.person_notes ?? '').trim();
  if (notes) parts.push(`Background notes: ${notes}`);
  const summary = (thread.summary ?? '').trim();
  if (summary) parts.push(`Existing summary: ${thread.summary}`);
  parts.push('Entries:');
  for (const e of detail?.entries ?? []) {
    parts.push(`- ${formatOccurredAt(e.occurred_at)} | ${entryActorLabel(e.direction, personName)} | ${(e.content ?? '').trim()}`);
  }
  return parts.join('\n');
};

export const build = async (input, locale) =>
  buildFormatted('summarize-thread', locale, buildThreadContext(input));
