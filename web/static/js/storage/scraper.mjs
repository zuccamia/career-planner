// BYOK scraper config. Stored in this browser's IndexedDB (same DB as the
// LLM BYOK config in byok.mjs). When enabled, the browser calls the
// configured backend (Firecrawl or Crawl4AI) directly and sends the
// resulting markdown to the server as `website_content` /
// `job_description_raw` on the LLM request — the key never touches the
// server.
//
// Config shape: { enabled, backend, baseUrl, apiKey, updatedAt }
//   backend: "firecrawl" | "crawl4ai"
//   apiKey:  required for Firecrawl, optional for Crawl4AI
//
// Deleted by:
//   - Settings → "Clear key"           (clearScraperConfig)
//   - Settings → "Wipe all local data" (idbWipe drops the DB)

import { idbGet, idbSet, idbDel } from './idb.mjs';

const KEY = 'scraperConfig';

// getScraperConfig returns the saved config, or null if the scraper has never
// been configured on this browser.
export const getScraperConfig = async () => {
  const raw = await idbGet(KEY);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
};

// isScraperConfigured is true when a config exists, is enabled, and has the fields
// needed to make a request. Firecrawl requires apiKey; Crawl4AI does not.
export const isScraperConfigured = async () => {
  const cfg = await getScraperConfig();
  if (!cfg || !cfg.enabled || !cfg.baseUrl || !cfg.backend) return false;
  if (cfg.backend === 'firecrawl' && !cfg.apiKey) return false;
  return true;
};

// saveScraperConfig persists a validated config. Callers should run
// testConnection first — this function only stores.
export const saveScraperConfig = async (cfg) => {
  const normalized = {
    enabled: !!cfg.enabled,
    backend: String(cfg.backend || '').trim(),
    baseUrl: String(cfg.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(cfg.apiKey || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  await idbSet(KEY, normalized);
  return normalized;
};

export const clearScraperConfig = () => idbDel(KEY);
