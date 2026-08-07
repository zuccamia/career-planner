// Prompt-injection markers and helpers ported from internal/sources/llm/
// safety.go. Kept in sync with the Go list one-for-one so a response the
// server would sanitize also sanitizes in-browser.

export const suspiciousTextMarkers = [
  'ignore previous instructions',
  'previous instructions',
  'prior instructions',
  'earlier instructions',
  'previous guidance',
  'prior guidance',
  'earlier guidance',
  'system prompt',
  'developer prompt',
  'hidden instructions',
  'internal instructions',
  'hidden prompt',
  'secret prompt',
  'underlying prompt',
  'initial prompt',
  'previous prompt',
  'earlier prompt',
  'show the prompt',
  'reveal the prompt',
  'print the prompt',
  'display the prompt',
  'follow these instructions',
  'ignore all instructions',
  'disregard instructions',
  'private note',
  'reveal private notes',
  'private notes',
  'internal note',
  'internal notes',
  'confidential note',
  'confidential notes',
  'hidden context',
  'internal context',
  'secret context',
  'unseen context',
  'complete this sentence',
];

export const isSuspiciousText = (raw) => {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return suspiciousTextMarkers.some((m) => lower.includes(m));
};

export const sanitizeText = (raw) => {
  const trimmed = (raw ?? '').trim();
  if (isSuspiciousText(trimmed)) return '';
  return trimmed;
};
