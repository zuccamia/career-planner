// Browser-direct web-search client. Mirrors internal/sources/search — the
// two live side-by-side because the LLM/scraper BYOK path already established
// this precedent. The browser calls Tavily or Brave directly with the user's
// saved config; the app server never sees the key.

import { getByokSearchConfig, DEFAULT_MAX_RESULTS } from './storage/byok-search.mjs';
import { fetchJSON, isFetchNetworkError } from './fetch-helpers.mjs';
import { t } from './i18n.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

// searchOpts applies the shared timeout + "search:" error prefix to every
// provider call. Callers pass method/body/headers on top.
const searchOpts = (extra) => ({ timeoutMs: DEFAULT_TIMEOUT_MS, errorPrefix: 'search', ...extra });

// --- Tavily --------------------------------------------------------------

const tavilySearch = async (cfg, query, opts) => {
  const maxResults = opts?.maxResults ?? cfg.maxResults ?? DEFAULT_MAX_RESULTS;
  const searchDepth = opts?.searchDepth || 'basic';
  const body = {
    api_key: cfg.apiKey,
    query,
    max_results: maxResults,
    search_depth: searchDepth,
    topic: 'general',
    // Explicit off — defaults but stated so a future API change can't silently
    // start returning heavy payloads.
    include_answer: false,
    include_images: false,
    include_raw_content: false,
  };
  // Tavily doesn't parse `site:` operators in the query; scope must come
  // through include_domains. Callers (Discover) pass the ATS host list here.
  if (opts?.includeDomains?.length) body.include_domains = opts.includeDomains;
  // Freshness cutoff, e.g. 1 for "past day". Mirrors the Go pipeline's
  // siteScopedTimeRange config on the SearXNG side.
  if (opts?.days > 0) body.days = opts.days;
  if (searchDepth === 'advanced' && opts?.chunksPerSource > 0) {
    body.chunks_per_source = opts.chunksPerSource;
  }
  const payload = await fetchJSON('https://api.tavily.com/search', searchOpts({ body }));
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map((r) => ({
    url: r.url || '',
    title: r.title || '',
    content: r.content || '',
    engine: 'tavily',
    publishedAt: r.published_date || '',
  }));
};

// --- Brave ---------------------------------------------------------------

const braveSearch = async (cfg, query, opts) => {
  const maxResults = opts?.maxResults ?? cfg.maxResults ?? DEFAULT_MAX_RESULTS;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const payload = await fetchJSON(url, searchOpts({
    method: 'GET',
    headers: {
      'X-Subscription-Token': cfg.apiKey,
      Accept: 'application/json',
    },
  }));
  const results = Array.isArray(payload.web?.results) ? payload.web.results : [];
  return results.map((r) => ({
    url: r.url || '',
    title: r.title || '',
    content: r.description || '',
    engine: 'brave',
    // Brave's response doesn't emit a reliable per-result publish date.
    publishedAt: '',
  }));
};

// --- Public API ----------------------------------------------------------

const dispatch = (provider) => {
  switch (provider) {
    case 'tavily': return tavilySearch;
    case 'brave': return braveSearch;
    default: throw new Error(t('settings.search.error.unknown_provider', { provider }));
  }
};

// search(query, opts?) — resolves saved config, dispatches to the provider.
// Returns a normalized array [{ url, title, content, engine, publishedAt }].
export const search = async (query, opts) => {
  const cfg = await getByokSearchConfig();
  if (!cfg || !cfg.enabled) throw new Error(t('settings.search.error.not_configured'));
  return dispatch(cfg.provider)(cfg, query, opts);
};

// testConnection(config) — used by the settings panel's Test button. Runs a
// minimal query with the provided (not saved) config and returns
// { ok, provider, sampleCount, error? }. CORS/auth failures append a hint.
export const testConnection = async (config) => {
  const provider = config.provider;
  try {
    const runSearch = dispatch(provider);
    const results = await runSearch(config, 'test', { maxResults: 1 });
    return { ok: Array.isArray(results), provider, sampleCount: results.length };
  } catch (err) {
    let hint = '';
    if (isFetchNetworkError(err)) hint = ' ' + t('settings.search.test.hint_cors');
    else if (err.status === 401 || err.status === 403) hint = ' ' + t('settings.search.test.hint_auth');
    return { ok: false, provider, error: (err.message || String(err)) + hint };
  }
};
