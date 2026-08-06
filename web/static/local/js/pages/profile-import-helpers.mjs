// Client-side helpers for the résumé-to-brags flow. Small pure functions kept
// out of the page module so they can be reasoned about (and unit-tested from
// Playwright if we ever add coverage) without touching the DOM.

// Threshold above which brag extraction fans out into per-section calls.
// Chosen empirically: ~2 pages of a résumé (≈ 2000 tokens). Below it, a
// single LLM call is faster than the request-fanout overhead.
export const MD_CHUNK_THRESHOLD_CHARS = 8000;

// chunkMarkdownBySections splits a Markdown résumé into chunks small enough
// for the LLM to attend to every bullet. Returns [md] verbatim when the
// input is short. Otherwise splits at `#`, descends to `##` and `###`, then
// falls back to item-level (top-level bullets or blank-line-separated
// paragraphs) for flat lists without per-item headings.
//
// Every produced chunk is prefixed with the ancestor heading trail (the
// enclosing `#`/`##` labels), so a bullet extracted from "## Role A" still
// tells the LLM which role it belongs to. Never returns empty chunks.
const HEADING_LEVELS = [/^# [^#]/, /^## /, /^### /];

const prependPath = (md, path) => path.length ? path.join('\n\n') + '\n\n' + md : md;

// peelLeadingHeading pulls the first heading line off `md` (if any). Used
// at the item-level fallback so a "## 2024 wins" sitting above a wall of
// bullets gets lifted into the trail instead of surviving as its own
// header-only item.
const peelLeadingHeading = (md) => {
  const lines = md.split('\n');
  const idx = lines.findIndex((l) => l.trim());
  if (idx < 0) return { heading: '', body: md };
  const first = lines[idx].trim();
  if (/^#+ /.test(first)) {
    return { heading: first, body: lines.slice(idx + 1).join('\n') };
  }
  return { heading: '', body: md };
};

// preambleHeading returns the first heading line found inside the preamble
// section of a heading-level split. That heading is the enclosing section's
// identity — folded into the trail so sibling sub-sections carry it.
const preambleHeading = (preamble) => {
  const lines = preamble.split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (/^#+ /.test(t)) return t;
  }
  return '';
};

const splitOversized = (md, maxChars, levelIdx, path = []) => {
  if (md.length <= maxChars) return [prependPath(md, path)];

  if (levelIdx < HEADING_LEVELS.length) {
    const parts = splitAtHeading(md, HEADING_LEVELS[levelIdx]);
    if (parts.length <= 1) return splitOversized(md, maxChars, levelIdx + 1, path);
    const out = [];
    // childPath = path used for level-L siblings. Starts as the caller's
    // path; once the preamble is processed, augment with its heading so
    // subsequent siblings carry the enclosing section label.
    let childPath = path;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const firstLine = p.split('\n')[0];
      const isSibling = HEADING_LEVELS[levelIdx].test(firstLine);
      if (i === 0 && !isSibling) {
        out.push(...splitOversized(p, maxChars, levelIdx + 1, path));
        const h = preambleHeading(p);
        if (h) childPath = [...path, h];
      } else {
        out.push(...splitOversized(p, maxChars, levelIdx + 1, childPath));
      }
    }
    return out;
  }

  // Past the heading levels — item-level fallback for flat lists. Peel any
  // leading heading off `md` and fold it into the trail so every item batch
  // carries the section label.
  const { heading, body } = peelLeadingHeading(md);
  const itemPath = heading ? [...path, heading] : path;
  const items = splitIntoItems(body);
  if (items.length <= 1) return [prependPath(md, path)];
  return packItems(items, maxChars).map((c) => prependPath(c, itemPath));
};

export const chunkMarkdownBySections = (md, { maxChars = MD_CHUNK_THRESHOLD_CHARS } = {}) => {
  const trimmed = String(md || '').trim();
  if (!trimmed) return [];
  return splitOversized(trimmed, maxChars, 0);
};

// chunkSnippet picks a short identifier for a chunk — used by the progress
// label so the user knows which section is in flight. Prefers the deepest
// heading in the chunk's leading heading-block (the local `### Refactored X`
// beats the ancestor `# Experience` breadcrumb prepended above it). Falls
// back to the first body line for item-level chunks with no local heading.
// Capped at `maxLen` chars so the status row stays single-line.
export const chunkSnippet = (chunk, maxLen = 80) => {
  const lines = String(chunk || '').split('\n').map((l) => l.trim());
  let deepestHeading = '';
  let firstBody = '';
  for (const l of lines) {
    if (!l) continue;
    if (/^#+ /.test(l)) {
      deepestHeading = l;
      continue;
    }
    // Non-heading content — stop scanning. Everything past here is body.
    firstBody = l;
    break;
  }
  const pick = deepestHeading || firstBody;
  return pick.length > maxLen ? pick.slice(0, maxLen - 1) + '…' : pick;
};

// splitAtHeading returns non-empty section strings, each beginning at a
// matching heading line. Any content before the first heading becomes the
// first section (so preamble like a name/contact block isn't lost).
const splitAtHeading = (md, headingRe) => {
  const lines = md.split('\n');
  const sections = [];
  let current = [];
  const flush = () => {
    const s = current.join('\n').trim();
    if (s) sections.push(s);
    current = [];
  };
  for (const line of lines) {
    if (headingRe.test(line) && current.some((l) => l.trim())) flush();
    current.push(line);
  }
  flush();
  return sections;
};

// splitIntoItems breaks a heading-less block into atomic items:
//   - top-level bullets (`- ` or `* ` at column 0) — each bullet is its own
//     item; continuation lines stay attached to their preceding bullet.
//   - numbered runs (`1. `, `2. `, …) — the *whole run* stays as one item.
//     Numbering implies order (priority, chronology), which packItems must
//     not break across LLM calls, so we coalesce the run.
//   - if no bullets and no numbers, falls back to blank-line-separated
//     paragraphs.
// Returns [] for whitespace-only input.
const BULLET_START = /^[-*] /;
const NUMBERED_START = /^\d+\.\s/;
const splitIntoItems = (md) => {
  const lines = md.split('\n');
  const hasList = lines.some((l) => BULLET_START.test(l) || NUMBERED_START.test(l));
  if (!hasList) {
    return md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }
  const items = [];
  let current = [];
  let mode = null; // 'bullet' | 'numbered' | null
  const flush = () => {
    const s = current.join('\n').trim();
    if (s) items.push(s);
    current = [];
    mode = null;
  };
  for (const line of lines) {
    if (BULLET_START.test(line)) {
      if (current.some((l) => l.trim())) flush();
      mode = 'bullet';
      current.push(line);
    } else if (NUMBERED_START.test(line)) {
      // Only flush when we're entering a numbered run from a different
      // mode — subsequent numbered lines coalesce into the same item.
      if (mode !== 'numbered' && current.some((l) => l.trim())) flush();
      mode = 'numbered';
      current.push(line);
    } else {
      // Continuation line — stays attached to whatever we're building.
      current.push(line);
    }
  }
  flush();
  return items;
};

// packItems groups adjacent items into chunks whose char count stays below
// maxChars. Individual items larger than maxChars still get their own
// oversize chunk (the LLM will see the full item verbatim — better than
// splitting mid-item).
const packItems = (items, maxChars) => {
  const chunks = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push(buf.join('\n\n'));
    buf = [];
    size = 0;
  };
  for (const item of items) {
    const itemLen = item.length + (buf.length ? 2 : 0); // +2 for the join "\n\n"
    if (size + itemLen > maxChars && buf.length) flush();
    buf.push(item);
    size += itemLen;
  }
  flush();
  return chunks;
};

// mapWithConcurrency runs `worker(item, idx)` across `items` with at most
// `limit` promises in flight. Results are returned in input order. Rejections
// propagate — the first failure aborts remaining scheduling and rejects the
// returned promise (in-flight work still resolves but is discarded).
export const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runOne = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(workers);
  return results;
};

// isRateLimitError sniffs common rate-limit signals across OpenAI-compatible
// providers. Errors bubble up as strings from BYOK's fetch layer, so we match
// on the message rather than a status code.
const RATE_LIMIT_MARKERS = ['rate limit', 'rate_limit', '429', 'too many requests', 'quota'];
export const isRateLimitError = (err) => {
  const msg = (err?.message || String(err || '')).toLowerCase();
  return RATE_LIMIT_MARKERS.some((m) => msg.includes(m));
};

// retryOnRateLimit runs `fn`; on a rate-limit error, sleeps `delayMs` (with
// small jitter) and retries once more. A second failure propagates. Kept
// intentionally simple — one retry is enough for the bursty BYOK case and
// avoids masking sustained quota exhaustion.
export const retryOnRateLimit = async (fn, { delayMs = 2000 } = {}) => {
  try {
    return await fn();
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    const jitter = Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, delayMs + jitter));
    return fn();
  }
};

// Session-scoped extraction cache — same MD + locale returns the same result
// within a page session so retries don't burn LLM tokens. The Map lives in
// module scope; navigating away discards it, which is what we want.

const cache = new Map();

// Async 32-bit FNV-1a-ish hash over UTF-8 bytes. SubtleCrypto is overkill for
// cache keys and adds an async barrier; a small non-crypto hash is fine.
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
};

export const cacheKey = (markdown, locale) => `${locale}:${hash(markdown)}`;

export const getCachedExtraction = (markdown, locale) => cache.get(cacheKey(markdown, locale));

export const setCachedExtraction = (markdown, locale, result) => {
  cache.set(cacheKey(markdown, locale), result);
};

// Apply-time dedup — refuse to insert a brag whose normalized (title, body)
// fingerprint matches an existing one. Callers pass the current brag list;
// this returns the subset of candidates safe to insert plus a parallel array
// of skipped-with-reason entries for the UI.

const fingerprint = (title, body) =>
  hash(
    (title + '\n' + body)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .join(' '),
  );

// filterDuplicatesAgainst returns { keep, skipped } where keep contains the
// candidates whose fingerprint isn't already present in `existing`, and
// skipped mirrors the candidates that were rejected with a `reason` of
// 'duplicate' and a `match` reference to the existing brag they collided with.
export const filterDuplicatesAgainst = (candidates, existing) => {
  const existingByFp = new Map();
  for (const e of existing || []) {
    existingByFp.set(fingerprint(e.title || '', e.body || ''), e);
  }
  const keep = [];
  const skipped = [];
  const seenInBatch = new Set();
  for (const c of candidates) {
    const fp = fingerprint(c.title || '', c.body || '');
    if (existingByFp.has(fp)) {
      skipped.push({ candidate: c, reason: 'duplicate', match: existingByFp.get(fp) });
      continue;
    }
    if (seenInBatch.has(fp)) {
      skipped.push({ candidate: c, reason: 'duplicate_in_batch' });
      continue;
    }
    seenInBatch.add(fp);
    keep.push(c);
  }
  return { keep, skipped };
};

// Similarity hint — for each candidate, find the closest existing brag by
// token Jaccard on the union of title + body. Score in [0, 1]; hint only
// when score exceeds SIMILARITY_HINT_THRESHOLD. Case- and punctuation-
// insensitive; strips a short English/Vietnamese stopword list so common
// filler words don't inflate scores.

export const SIMILARITY_HINT_THRESHOLD = 0.4;

const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
  'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'this', 'that', 'these',
  'those', 'it', 'its', 'i', 'we', 'our', 'you', 'your', 'they', 'their', 'my', 'me',
  // Vietnamese common connectors
  'và', 'của', 'là', 'các', 'một', 'với', 'cho', 'trong', 'khi', 'đã', 'được', 'không',
  'này', 'đó', 'để', 'ra', 'vào', 'trên', 'dưới', 'sẽ', 'có',
]);

const tokenize = (s) =>
  new Set(
    (s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w)),
  );

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
};

// findClosestExisting returns { match, score } — the highest-scoring existing
// brag against the candidate. `match` is null when no existing brag exceeds
// SIMILARITY_HINT_THRESHOLD.
export const findClosestExisting = (candidate, existing) => {
  const candTokens = tokenize((candidate.title || '') + ' ' + (candidate.body || ''));
  let best = { match: null, score: 0 };
  for (const e of existing || []) {
    const s = jaccard(candTokens, tokenize((e.title || '') + ' ' + (e.body || '')));
    if (s > best.score) best = { match: e, score: s };
  }
  if (best.score < SIMILARITY_HINT_THRESHOLD) best.match = null;
  return best;
};
