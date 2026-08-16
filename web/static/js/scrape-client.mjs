// Browser-direct scraper client. Mirrors internal/sources/scrape/client.go —
// the two live side-by-side because the LLM BYOK path already established this
// precedent (see llm-client.mjs). The browser calls Firecrawl / Crawl4AI
// directly with the user's saved config; the app server never sees the key.

import { getByokScraperConfig } from './storage/byok-scraper.mjs';
import { isStaticHost } from './host.mjs';
import { isFetchNetworkError } from './fetch-helpers.mjs';
import { t } from './i18n.mjs';

// getServerScraperStatus reports whether the deploy has a server-side
// scraper configured. On the static build there IS no server — skip the
// fetch and answer directly. Hosted deploy fetches
// /api/scrape/server-status once per session and caches the promise.
let serverScraperStatusPromise = null;
export const getServerScraperStatus = () => {
  if (isStaticHost()) return Promise.resolve({ available: false, provider: '' });
  if (!serverScraperStatusPromise) {
    serverScraperStatusPromise = fetch('/api/scrape/server-status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        // Reset so a later call can retry; treat network errors as "no
        // scraper" so we don't render a false hint.
        serverScraperStatusPromise = null;
        console.warn('[local] scrape server-status fetch failed', err);
        return { available: false, provider: '' };
      });
  }
  return serverScraperStatusPromise;
};

const DEFAULT_TIMEOUT_MS = 60_000;

const withTimeout = (ms) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
};

const fetchJSON = async (url, { method = 'POST', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: t.signal,
    });
    const text = await res.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { raw: text }; }
    if (!res.ok) {
      const msg = payload.error || payload.detail || `HTTP ${res.status}`;
      const err = new Error(`scraper: ${msg}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    t.cancel();
  }
};

// --- Firecrawl -----------------------------------------------------------

const firecrawlScrape = async (cfg, url, opts) => {
  const payload = await fetchJSON(`${cfg.baseUrl}/v1/scrape`, {
    body: {
      url,
      formats: (opts && opts.formats) || ['markdown'],
      onlyMainContent: opts?.onlyMainContent ?? true,
      waitFor: opts?.waitFor ?? 0,
    },
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  return {
    url,
    markdown: payload.data?.markdown || '',
    html: payload.data?.html || '',
    metadata: payload.data?.metadata || {},
    provider: 'firecrawl',
    fetchedAt: new Date().toISOString(),
  };
};

const firecrawlMap = async (cfg, url) => {
  const payload = await fetchJSON(`${cfg.baseUrl}/v1/map`, {
    body: { url },
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  return {
    domain: url,
    urls: payload.links || [],
    provider: 'firecrawl',
    fetchedAt: new Date().toISOString(),
  };
};

// --- Crawl4AI ------------------------------------------------------------

const crawl4aiHeaders = (cfg) => cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};

const crawl4aiScrape = async (cfg, url) => {
  const payload = await fetchJSON(`${cfg.baseUrl}/md`, {
    body: { url },
    headers: crawl4aiHeaders(cfg),
  });
  return {
    url,
    markdown: payload.markdown || '',
    html: '',
    metadata: payload.metadata || {},
    provider: 'crawl4ai',
    fetchedAt: new Date().toISOString(),
  };
};

const hrefRE = /href\s*=\s*["']([^"']+)["']/gi;

const crawl4aiMap = async (cfg, url) => {
  const payload = await fetchJSON(`${cfg.baseUrl}/html`, {
    body: { url },
    headers: crawl4aiHeaders(cfg),
  });
  const html = payload.html || '';
  const seen = new Set();
  const urls = [];
  let base;
  try { base = new URL(url); } catch { base = null; }
  for (const m of html.matchAll(hrefRE)) {
    const raw = (m[1] || '').trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;
    let abs;
    try { abs = base ? new URL(raw, base).toString() : new URL(raw).toString(); }
    catch { continue; }
    // Strip fragment
    abs = abs.replace(/#.*$/, '');
    if (seen.has(abs)) continue;
    seen.add(abs);
    urls.push(abs);
  }
  return { domain: url, urls, provider: 'crawl4ai', fetchedAt: new Date().toISOString() };
};

// --- Public API ----------------------------------------------------------

const dispatch = (cfg) => {
  switch (cfg.provider) {
    case 'firecrawl':
      return { scrape: firecrawlScrape, mapDomain: firecrawlMap };
    case 'crawl4ai':
      return { scrape: crawl4aiScrape, mapDomain: crawl4aiMap };
    default:
      throw new Error(t('settings.scraper.error.unknown_provider', { provider: cfg.provider }));
  }
};

// scrape(url, opts?) — resolves saved config, dispatches to the provider.
export const scrape = async (url, opts) => {
  const cfg = await getByokScraperConfig();
  if (!cfg || !cfg.enabled) throw new Error(t('settings.scraper.error.not_configured'));
  return dispatch(cfg).scrape(cfg, url, opts);
};

// mapDomain(url, opts?) — same, for the Map endpoint.
export const mapDomain = async (url, opts) => {
  const cfg = await getByokScraperConfig();
  if (!cfg || !cfg.enabled) throw new Error(t('settings.scraper.error.not_configured'));
  return dispatch(cfg).mapDomain(cfg, url, opts);
};

// testConnection(config) — used by the settings panel's Test button before
// save. Runs a minimal scrape of https://example.com against the provided
// config (not the saved one) and returns { ok, provider, error? }. CORS or
// auth failures surface with a hint so the UI can point at the README.
export const testConnection = async (config) => {
  const provider = config.provider;
  const disp = { firecrawl: firecrawlScrape, crawl4ai: crawl4aiScrape }[provider];
  if (!disp) return { ok: false, error: t('settings.scraper.error.unknown_provider', { provider }) };
  try {
    const res = await disp(config, 'https://example.com', { onlyMainContent: true });
    return { ok: !!res.markdown, provider, sampleLength: (res.markdown || '').length };
  } catch (err) {
    let hint = '';
    if (isFetchNetworkError(err)) hint = t('settings.scraper.test.hint_cors');
    else if (err.status === 401 || err.status === 403) hint = t('settings.scraper.test.hint_auth');
    return { ok: false, provider, error: (err.message || String(err)) + hint };
  }
};

