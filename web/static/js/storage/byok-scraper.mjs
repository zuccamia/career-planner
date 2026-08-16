// BYOK scraper config. Stored in this browser's IndexedDB (same DB as the
// LLM BYOK config in byok-llm.mjs). When enabled, the browser calls the
// configured provider (Firecrawl or Crawl4AI) directly and sends the
// resulting markdown to the server as `website_content` /
// `job_description_raw` on the LLM request — the key never touches the
// server.
//
// Config shape: { enabled, provider, baseUrl, apiKey, updatedAt }
//   provider: "firecrawl" | "crawl4ai"
//   apiKey:   required for Firecrawl, optional for Crawl4AI
//
// Deleted by:
//   - Settings → "Clear key"           (clearByokScraperConfig)
//   - Settings → "Wipe all local data" (idbWipe drops the DB)

import { idbGet, idbSet, idbDel } from './idb.mjs';

const KEY = 'scraperConfig';

// Supported providers and their metadata. The Settings form seeds the URL
// field from PROVIDERS[cfg.provider].defaultBaseUrl and swaps when the
// provider <select> changes. requiresApiKey drives save/test validation and
// the "is BYOK active" check.
export const PROVIDERS = {
  firecrawl: { defaultBaseUrl: 'https://api.firecrawl.dev', requiresApiKey: true },
  crawl4ai:  { defaultBaseUrl: 'http://localhost:11235',    requiresApiKey: false },
};
export const PROVIDER_KEYS = Object.keys(PROVIDERS);
export const DEFAULT_PROVIDER = 'firecrawl';

// getByokScraperConfig returns the saved config, or null if the scraper has never
// been configured on this browser. Reads legacy `cfg.backend` into `provider`
// so configs saved before the rename keep working.
export const getByokScraperConfig = async () => {
  const raw = await idbGet(KEY);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.provider == null && raw.backend != null) raw.provider = raw.backend;
  return raw;
};

// isByokScraperActive is true when a config exists, is enabled, and has the fields
// needed to make a request. Firecrawl requires apiKey; Crawl4AI does not.
export const isByokScraperActive = async () => {
  const cfg = await getByokScraperConfig();
  if (!cfg || !cfg.enabled || !cfg.baseUrl || !cfg.provider) return false;
  if (PROVIDERS[cfg.provider]?.requiresApiKey && !cfg.apiKey) return false;
  return true;
};

// saveByokScraperConfig persists a validated config. Callers should run
// testConnection first — this function only stores.
export const saveByokScraperConfig = async (cfg) => {
  const normalized = {
    enabled: !!cfg.enabled,
    provider: String(cfg.provider || '').trim(),
    baseUrl: String(cfg.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(cfg.apiKey || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  await idbSet(KEY, normalized);
  return normalized;
};

export const clearByokScraperConfig = () => idbDel(KEY);
