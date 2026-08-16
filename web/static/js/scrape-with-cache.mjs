// Cache-aware scraping helpers used by any browser flow that needs to fold
// scraped markdown into an LLM prompt. Wraps the L1+L2 cache from
// storage/scrape-cache.mjs around the browser-direct scraper in
// scrape-client.mjs and reports progress through the rpc.mjs step-callback
// contract.

import { getByokScraperConfig } from './storage/byok-scraper.mjs';
import { getCachedScrape, putCachedScrape } from './storage/scrape-cache.mjs';
import { scrape as browserScrape } from './scrape-client.mjs';
import { stepped, noopStep } from './ui/progress.mjs';

// resolveProvider reads the saved scraper config and returns the provider id.
// Callers are expected to have gated on isByokScraperActive() upstream, so cfg
// and cfg.provider are always populated here. Returns undefined if not — the
// downstream dispatch in scrape-client.mjs will throw a clear "unknown
// scraper provider" error.
const resolveProvider = async () => {
  const cfg = await getByokScraperConfig();
  return cfg?.provider;
};

// scrapeWithCache: check the two-layer cache; on miss, browser-scrape and
// write back. Emits a progress step keyed by opts.stepName. Throws on
// underlying scrape failure — callers who want non-fatal behavior should
// wrap in try/catch or use scrapeInParallel.
//
//   opts: { provider?, ttlSeconds, stepName, onStep }
export const scrapeWithCache = async (url, opts = {}) => {
  const { ttlSeconds, stepName, onStep = noopStep } = opts;
  if (!url) return '';
  const provider = opts.provider || await resolveProvider();
  return stepped(onStep, stepName || 'scrape', async () => {
    const cached = await getCachedScrape(url, provider, ttlSeconds);
    if (cached) return cached;
    const res = await browserScrape(url, { onlyMainContent: true });
    const md = res.markdown || '';
    if (md) await putCachedScrape(url, provider, md, ttlSeconds);
    return md;
  }, { emptyIf: (md) => !md });
};

// scrapeInParallel: run scrapeWithCache for each target concurrently, with
// per-target try/catch so one failure doesn't drop the others. Falsy urls are
// dropped from the batch (no step emitted).
//
//   targets: [{ stepName, url, key }]   // key names the return-dict entry
//   opts:    { provider?, ttlSeconds, onStep }
//
// Returns { [key]: markdown } for each target that produced non-empty content.
export const scrapeInParallel = async (targets, opts = {}) => {
  const { ttlSeconds, onStep = noopStep } = opts;
  const provider = opts.provider || await resolveProvider();
  const results = {};
  await Promise.all(
    targets
      .filter(t => t && t.url)
      .map(async (t) => {
        try {
          const md = await scrapeWithCache(t.url, { provider, ttlSeconds, stepName: t.stepName, onStep });
          if (md) results[t.key] = md;
        } catch (err) {
          console.warn(`scrapeInParallel: ${t.stepName || t.url} failed, continuing:`, err);
        }
      }),
  );
  return results;
};
