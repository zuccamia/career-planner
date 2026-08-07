// Cache-aware scraping helpers used by any browser flow that needs to fold
// scraped markdown into an LLM prompt. Wraps the L1+L2 cache from
// storage/scrape-cache.mjs around the browser-direct scraper in
// scrape-client.mjs and reports progress through the rpc.mjs step-callback
// contract.

import { getScraperConfig } from './storage/scraper.mjs';
import { getCachedScrape, putCachedScrape } from './storage/scrape-cache.mjs';
import { scrape as browserScrape } from './scrape-client.mjs';

// Default onStep so scrape helpers can invoke the callback unconditionally
// without guarding on undefined. Callers that want progress reporting pass
// a real callback (see ui/progress.mjs).
const noopStep = () => {};

// Emit running → done/failed around fn. Same contract as rpc.mjs' `stepped`
// but duplicated here to keep this module independent of rpc.mjs (avoids the
// import cycle when rpc.mjs imports this module).
const withStep = async (onStep, name, fn) => {
  onStep({ name, status: 'running' });
  try {
    const out = await fn();
    onStep({ name, status: 'done' });
    return out;
  } catch (err) {
    onStep({ name, status: 'failed', error: err && (err.message || String(err)) });
    throw err;
  }
};

// resolveBackend reads the saved scraper config and returns the backend id.
// Callers are expected to have gated on isScraperConfigured() upstream, so cfg
// and cfg.backend are always populated here. Returns undefined if not — the
// downstream dispatch in scrape-client.mjs will throw a clear "unknown
// scraper backend" error.
const resolveBackend = async () => {
  const cfg = await getScraperConfig();
  return cfg?.backend;
};

// scrapeWithCache: check the two-layer cache; on miss, browser-scrape and
// write back. Emits a progress step keyed by opts.stepName. Throws on
// underlying scrape failure — callers who want non-fatal behavior should
// wrap in try/catch or use scrapeInParallel.
//
//   opts: { backend?, ttlSeconds, stepName, onStep }
export const scrapeWithCache = async (url, opts = {}) => {
  const { ttlSeconds, stepName, onStep = noopStep } = opts;
  if (!url) return '';
  const backend = opts.backend || await resolveBackend();
  return withStep(onStep, stepName || 'scrape', async () => {
    const cached = await getCachedScrape(url, backend, ttlSeconds);
    if (cached) return cached;
    const res = await browserScrape(url, { onlyMainContent: true });
    const md = res.markdown || '';
    if (md) await putCachedScrape(url, backend, md, ttlSeconds);
    return md;
  });
};

// scrapeInParallel: run scrapeWithCache for each target concurrently, with
// per-target try/catch so one failure doesn't drop the others. Falsy urls are
// dropped from the batch (no step emitted).
//
//   targets: [{ stepName, url, key }]   // key names the return-dict entry
//   opts:    { backend?, ttlSeconds, onStep }
//
// Returns { [key]: markdown } for each target that produced non-empty content.
export const scrapeInParallel = async (targets, opts = {}) => {
  const { ttlSeconds, onStep = noopStep } = opts;
  const backend = opts.backend || await resolveBackend();
  const results = {};
  await Promise.all(
    targets
      .filter(t => t && t.url)
      .map(async (t) => {
        try {
          const md = await scrapeWithCache(t.url, { backend, ttlSeconds, stepName: t.stepName, onStep });
          if (md) results[t.key] = md;
        } catch (err) {
          console.warn(`scrapeInParallel: ${t.stepName || t.url} failed, continuing:`, err);
        }
      }),
  );
  return results;
};
