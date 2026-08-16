// Discover pipeline client. See docs/deployment-matrix.md for routing.
// Dashboard entry point is discover(); the two branches are discoverInBrowser
// (BYOK LLM + BYOK search) and discoverOnServer (fully server-side; may
// carry browser_hits when only BYOK search is configured).

import { isStaticHost } from './host.mjs';
import { buildSiteScopedQuery } from './discover/query.mjs';
import { isScarceEmployment } from './discover/helpers.mjs';
import { loadATSSearchHosts as atsHosts } from './ats-lookup.mjs';
import { normalizeURL, filterStalePostings, filterDeadLinks, collectBrowserHits, preFilterHits, goneCache } from './discover/helpers.mjs';
import { extractPostings } from './discover/extract.mjs';
import { isATSLandingPage } from './ats-lookup.mjs';
import { search as browserSearch } from './search-client.mjs';
import { isByokSearchActive } from './storage/byok-search.mjs';
import { isByokLLMActive, getByokLLMConfig } from './storage/byok-llm.mjs';
import { callOpenAICompatible } from './llm-client.mjs';
import { build as buildExpandPrompt, finalizeExpandSignals } from './llm/parse/discover-expand-signals.mjs';
import { build as buildRankPrompt, finalizeRank } from './llm/parse/discover-rank.mjs';
import { decodeJSONResponse } from './llm/decode.mjs';
import { currentLocale, t } from './i18n.mjs';
import { fetchJSON } from './fetch-helpers.mjs';
import { stepped, noopStep } from './ui/progress.mjs';

const DEFAULT_LIMIT = 10;
// Survivor target, not attempt cap — extract keeps going until this many
// non-gone postings or hits run out.
const EXTRACT_BUDGET = 40;
const SEARCH_PER_HOST = 10;
const SEARCH_HOST_CONCURRENCY = 3;

// getServerDiscoverStatus reports whether the deploy has the discovery
// pipeline wired up (server-side LLM + SearXNG). Static build: no server.
let serverDiscoverStatusPromise = null;
export const getServerDiscoverStatus = () => {
  if (isStaticHost()) return Promise.resolve({ available: false, provider: '' });
  if (!serverDiscoverStatusPromise) {
    serverDiscoverStatusPromise = fetch('/api/discover/server-status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        serverDiscoverStatusPromise = null;
        console.warn('[local] discover server-status fetch failed', err);
        return { available: false, provider: '' };
      });
  }
  return serverDiscoverStatusPromise;
};

// discoverOnServer POSTs the pipeline request to the server. Non-2xx throws.
// onStep fires once around the whole POST because the server returns a
// single JSON response; per-step progress needs SSE/NDJSON (future work).
export const discoverOnServer = async (body, { timeoutMs = 90_000, onStep = noopStep } = {}) =>
  (await stepped(onStep, 'server_run', () =>
    fetchJSON('/api/discover/run', { body, timeoutMs }))) || {};

// searchInBrowser fans out one strict site-scoped query per ATS host via
// the BYOK search provider. No fallback ladder: protects the user's paid
// Tavily/Brave quota.
const searchInBrowser = async (signals, req) => {
  const hosts = await atsHosts();
  const employmentType = req.profile?.employment_type || '';
  // Freshness window matches the Go pipeline's siteScopedTimeRange: 1 day for
  // full-time roles, 30 days for scarce (intern/new-grad) cycle-posted roles.
  const freshnessDays = isScarceEmployment(employmentType) ? 30 : 1;
  const groups = [];
  for (let i = 0; i < hosts.length; i += SEARCH_HOST_CONCURRENCY) {
    const batch = hosts.slice(i, i + SEARCH_HOST_CONCURRENCY);
    const results = await Promise.all(batch.map(async (host) => {
      const q = buildSiteScopedQuery(
        host,
        signals.role_variants,
        signals.broad_role,
        signals.signal_keywords,
        req.profile?.locations || [],
        employmentType,
      );
      if (!q) return null;
      try {
        const hits = await browserSearch(q, {
          maxResults: SEARCH_PER_HOST,
          // Tavily needs explicit domain scope; Brave honors site: in the query.
          includeDomains: [host.host],
          days: freshnessDays,
        });
        return {
          host: host.host,
          provider: host.provider,
          board_url: `https://${host.host}`,
          results: (hits || []).map((h) => ({
            url: h.url,
            title: h.title,
            content: h.content,
            engine: h.engine,
            ...(h.publishedAt ? { published_at: h.publishedAt } : {}),
          })),
        };
      } catch (err) {
        console.warn('[discover] search failed', host.host, err);
        return null;
      }
    }));
    for (const g of results) if (g && g.results.length) groups.push(g);
  }
  return groups;
};

// searchOnServer POSTs to /api/discover/search, returning the same
// BrowserHitGroup shape a BYOK search fanout would.
const searchOnServer = async (signals, req) => {
  const body = await fetchJSON('/api/discover/search', {
    body: { signals, profile: req.profile || {}, locale: req.locale || '' },
    errorPrefix: 'discover search',
  });
  return body.groups || [];
};

// discoverInBrowser composes the pipeline in the browser. Requires BYOK LLM
// (expand + rank). The search stage runs via BYOK search when configured,
// else /api/discover/search when the server has it. Prompt assembly and
// parsing use the JS ports in llm/parse/discover-*.mjs. onStep fires
// per real pipeline stage (expand / search / extract / rank).
export const discoverInBrowser = async (req, { onStep = noopStep } = {}) => {
  const locale = req.locale || currentLocale();
  const limit = req.limit > 0 ? req.limit : DEFAULT_LIMIT;
  const cfg = await getByokLLMConfig();
  if (!cfg) throw new Error(t('discover.error.llm_missing'));
  const byokSearchActive = await isByokSearchActive();
  if (!byokSearchActive && (isStaticHost() || !(await getServerDiscoverStatus()).search_available)) {
    throw new Error(t('discover.error.search_missing'));
  }

  const signals = await stepped(onStep, 'expand', async () => {
    const expandPrompt = await buildExpandPrompt(req, locale);
    const expandRaw = await callOpenAICompatible({ system: expandPrompt.system, user: expandPrompt.user }, cfg);
    const s = finalizeExpandSignals(decodeJSONResponse(expandRaw), req);
    if (s.role_variants.length === 0) {
      const headline = (req.profile?.headline || '').trim();
      if (headline) s.role_variants = [headline];
    }
    return s;
  });

  const hits = await stepped(onStep, 'search', async () => {
    const hitsByHost = byokSearchActive ? await searchInBrowser(signals, req) : await searchOnServer(signals, req);
    return collectBrowserHits(hitsByHost);
  });
  if (hits.length === 0) {
    return { recommendations: [], diagnostics: [t('discover.diagnostic.no_hits')] };
  }

  const existingURLs = new Set();
  for (const a of req.applications || []) {
    const key = normalizeURL(a.job_url); if (key) existingURLs.add(key);
  }
  for (const u of req.exclude_urls || []) {
    const key = normalizeURL(u); if (key) existingURLs.add(key);
  }
  // Pre-extract triage matches the server's preFilterHits (dedupe /
  // landing shape / gone cache) so budget slots go to hits with a real
  // chance of surviving the pipeline.
  const { hits: freshHits } = await preFilterHits(hits, existingURLs, isATSLandingPage, goneCache);
  if (freshHits.length === 0) {
    return { recommendations: [], diagnostics: [t('discover.diagnostic.all_tracked')] };
  }

  const { survivors, extracted } = await stepped(onStep, 'extract', async () => {
    const { postings } = await extractPostings(freshHits, { budget: EXTRACT_BUDGET, gone: goneCache });
    return { survivors: filterStalePostings(postings, req.profile?.employment_type || ''), extracted: postings.length };
  });
  if (survivors.length === 0) {
    const key = extracted === 0 ? 'discover.diagnostic.all_gone' : 'discover.diagnostic.all_stale';
    return { recommendations: [], diagnostics: [t(key)] };
  }

  const recs = await stepped(onStep, 'rank', async () => {
    const rankPrompt = await buildRankPrompt({ request: req, postings: survivors, limit }, locale);
    const rankRaw = await callOpenAICompatible({ system: rankPrompt.system, user: rankPrompt.user }, cfg);
    const ranked = finalizeRank(decodeJSONResponse(rankRaw), survivors, limit);
    return await filterDeadLinks(ranked, goneCache);
  });
  return { recommendations: recs, diagnostics: [] };
};

// discover is the dashboard entry point. Routes per docs/deployment-matrix.md.
export const discover = async (req, { onStep = noopStep } = {}) => {
  if (await isByokLLMActive()) return discoverInBrowser(req, { onStep });
  if (isStaticHost()) throw new Error(t('discover.error.llm_missing'));

  if (await isByokSearchActive()) {
    // Server LLM + BYOK search: prefill browser_hits so the search step
    // honors the user's key. No expand signals available here (LLM lives
    // server-side), so fall back to the raw headline as the sole role query.
    const headline = (req.profile?.headline || '').trim();
    const naiveSignals = { role_variants: headline ? [headline] : [], signal_keywords: [], broad_role: '' };
    const hitsByHost = await stepped(onStep, 'search', () => searchInBrowser(naiveSignals, req));
    return discoverOnServer({ ...req, browser_hits: hitsByHost }, { onStep });
  }

  return discoverOnServer(req, { onStep });
};
