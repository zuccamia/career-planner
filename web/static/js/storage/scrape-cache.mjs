// Two-layer scrape cache. Keyed by sha256(url + provider) so hosted-Firecrawl
// and self-hosted-Crawl4AI results for the same URL stay independent (enables
// side-by-side quality comparison).
//
//   L1 — an in-memory Map, scoped to this browser tab. Free hit (no I/O).
//        Cleared on tab close / reload. Wins on repeat lookups within a
//        single session (e.g. building several artifacts for the same
//        company back-to-back).
//   L2 — a storage-backend blob under `scrapes/<sha>.md` plus a JSON sidecar
//        `<sha>.json` carrying {url, provider, fetchedAt, ttlSeconds}. Metadata
//        is intentionally NOT inserted into the SQLite attachments table —
//        scrape cache is transient/derived data; user attachments are not.
//
// Users with no storage backend enabled get L1 only. They lose cross-session
// caching but the app already has this limitation for user attachments — not
// a new failure mode.

import { availableBackends, localDisk, googleDrive } from './index.mjs';

const FOLDER = 'scrapes';
const SIDECAR_SUFFIX = '.json';
const BODY_SUFFIX = '.md';

const l1 = new Map(); // key -> { markdown, expiresAt (ms epoch), provider, url }

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sha256Hex = async (str) => {
  const bytes = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

const cacheKey = (url, provider) => sha256Hex(`${provider}\n${url}`);

// getCachedScrape returns cached markdown when a fresh hit exists in either
// layer, else null. ttlSeconds < 0 means "always fresh, never cache."
export const getCachedScrape = async (url, provider, ttlSeconds) => {
  if (!url || !provider || ttlSeconds <= 0) return null;
  const key = await cacheKey(url, provider);

  // L1
  const l1Hit = l1.get(key);
  if (l1Hit && l1Hit.expiresAt > Date.now()) {
    return l1Hit.markdown;
  }
  if (l1Hit) l1.delete(key);

  // L2: try local disk first, then Drive. Bail on the first storage backend
  // that has the sidecar — if the sidecar exists but is stale, remove it
  // (best effort) and return null so the caller re-scrapes.
  const backends = [localDisk, googleDrive].filter(b => b.isAvailable());
  for (const b of backends) {
    try {
      if (!(await b.hasAttachment(FOLDER, key + SIDECAR_SUFFIX))) continue;
      const sidecarBytes = await b.loadAttachment(FOLDER, key + SIDECAR_SUFFIX);
      const meta = JSON.parse(decoder.decode(sidecarBytes));
      const ageSec = (Date.now() - new Date(meta.fetchedAt).getTime()) / 1000;
      if (ageSec > (meta.ttlSeconds ?? ttlSeconds)) {
        // Stale — evict via the coordinator so the fan-out delete runs.
        removeStaleEntry(key).catch(err => console.warn('scrape-cache: evict failed', err));
        return null;
      }
      const bodyBytes = await b.loadAttachment(FOLDER, key + BODY_SUFFIX);
      const markdown = decoder.decode(bodyBytes);
      // Promote to L1 for the rest of the session.
      l1.set(key, { markdown, expiresAt: Date.now() + ttlSeconds * 1000, provider, url });
      return markdown;
    } catch (err) {
      console.warn(`scrape-cache: L2 read from ${b.name} failed for ${url}:`, err);
    }
  }
  return null;
};

// putCachedScrape writes a fresh scrape result to both cache layers.
export const putCachedScrape = async (url, provider, markdown, ttlSeconds) => {
  if (!url || !provider || !markdown || ttlSeconds <= 0) return;
  const key = await cacheKey(url, provider);

  // L1 always.
  l1.set(key, { markdown, expiresAt: Date.now() + ttlSeconds * 1000, provider, url });

  // L2: fan-out best-effort. Errors are logged, not thrown — the caller
  // already has the markdown in hand.
  const backends = availableBackends();
  if (backends.length === 0) return;

  const bodyBytes = encoder.encode(markdown);
  const sidecarBytes = encoder.encode(JSON.stringify({
    url,
    provider,
    fetchedAt: new Date().toISOString(),
    ttlSeconds,
  }));
  for (const b of backends) {
    try {
      await b.saveAttachment(FOLDER, key + BODY_SUFFIX, bodyBytes);
      await b.saveAttachment(FOLDER, key + SIDECAR_SUFFIX, sidecarBytes);
    } catch (err) {
      console.warn(`scrape-cache: L2 write to ${b.name} failed for ${url}:`, err);
    }
  }
};

const removeStaleEntry = async (key) => {
  const backends = availableBackends();
  for (const b of backends) {
    try { await b.deleteAttachment(FOLDER, key + BODY_SUFFIX); } catch (_) {}
    try { await b.deleteAttachment(FOLDER, key + SIDECAR_SUFFIX); } catch (_) {}
  }
  l1.delete(key);
};
