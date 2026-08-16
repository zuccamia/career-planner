// BYOK web-search config. Stored in this browser's IndexedDB alongside the
// LLM (byok-llm.mjs) and scraper (byok-scraper.mjs) configs. When enabled, the
// browser calls Tavily or Brave Search directly; the key never touches the
// app server.
//
// Config shape: { enabled, provider, apiKey, maxResults, updatedAt }
//   provider: "tavily" | "brave"
//   apiKey:   required for both providers
//
// Deleted by:
//   - Settings → "Clear key"           (clearByokSearchConfig)
//   - Settings → "Wipe all local data" (idbWipe drops the DB)

import { idbGet, idbSet, idbDel } from './idb.mjs';

const KEY = 'searchConfig';

export const PROVIDER_KEYS = ['tavily', 'brave'];
export const DEFAULT_PROVIDER = 'tavily';
const DEFAULT_MAX_RESULTS = 10;

// getByokSearchConfig reads the saved config. Legacy `cfg.backend` is
// surfaced as `provider` so configs saved before the rename keep working.
export const getByokSearchConfig = async () => {
  const raw = await idbGet(KEY);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.provider == null && raw.backend != null) raw.provider = raw.backend;
  return raw;
};

export const isByokSearchActive = async () => {
  const cfg = await getByokSearchConfig();
  if (!cfg || !cfg.enabled || !cfg.provider || !cfg.apiKey) return false;
  return true;
};

export const saveByokSearchConfig = async (cfg) => {
  const max = Number(cfg.maxResults);
  const normalized = {
    enabled: !!cfg.enabled,
    provider: String(cfg.provider || '').trim(),
    apiKey: String(cfg.apiKey || '').trim(),
    maxResults: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_RESULTS,
    updatedAt: new Date().toISOString(),
  };
  await idbSet(KEY, normalized);
  return normalized;
};

export const clearByokSearchConfig = () => idbDel(KEY);

export { DEFAULT_MAX_RESULTS };
