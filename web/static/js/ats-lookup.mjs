// URL → ATS provider inference + ATS-root discovery for a given website.
// Shared config with the Go side: web/static/data/ats-providers.json is the
// single source of truth. Loaded once at module boot; every export awaits
// the load internally.

import { mapDomain } from './scrape-client.mjs';
import { STATIC_ROOT } from './host.mjs';
import { hostOf } from './fetch-helpers.mjs';
import { fetchPosting as greenhouseFetch, supports as greenhouseSupports } from './sources/ats/greenhouse.mjs';
import { fetchPosting as leverFetch, supports as leverSupports } from './sources/ats/lever.mjs';
import { fetchPosting as ashbyFetch, supports as ashbySupports } from './sources/ats/ashby.mjs';

const PROVIDERS_URL = `${STATIC_ROOT}data/ats-providers.json`;

let providersPromise = null;

// loadProviders fetches ats-providers.json and returns a normalized list.
// Cached on success; reset on failure so a later call can retry (matches the
// resilience pattern of getServerLLMStatus).
const loadProviders = () => {
  if (providersPromise) return providersPromise;
  providersPromise = fetch(PROVIDERS_URL, { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`fetch ${PROVIDERS_URL}: HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => data.map((p) => ({
      provider: p.provider,
      hostRegex: new RegExp(p.host_pattern, 'i'),
      searchHosts: p.search_hosts || [],
      slugInPath: !!p.slug_in_path,
    })))
    .catch((err) => {
      providersPromise = null;
      throw err;
    });
  return providersPromise;
};

// loadATSSearchHosts flattens providers into the search-host list Discover's
// site-scoped query builder iterates. Shape mirrors internal/sources/ats
// SearchHosts() so both sides read the same rows.
export const loadATSSearchHosts = async () => {
  const providers = await loadProviders();
  const out = [];
  for (const p of providers) {
    for (const host of p.searchHosts) out.push({ host, provider: p.provider });
  }
  return out;
};

// lookupATSURL returns { atsURL, provider } on first match, or empty
// values on no match. Called from the dossier flow when the user gave a
// website but no ATS URL and BYOK scraping is active.
export const lookupATSURL = async (companyWebsite) => {
  if (!companyWebsite) return { atsURL: '', provider: '' };
  const providers = await loadProviders();
  const res = await mapDomain(companyWebsite);
  for (const u of res.urls || []) {
    const host = hostOf(u);
    if (!host) continue;
    for (const p of providers) {
      if (p.hostRegex.test(host)) return { atsURL: u, provider: p.provider };
    }
  }
  return { atsURL: '', provider: '' };
};

// inferATSFromPostingURL derives the ATS root + provider from a single
// posting URL. For multi-tenant hosts where the tenant slug is in the path
// (slugInPath), the root is `origin/<slug>`; otherwise `origin`. Used by
// Discover's "Save as application" flow to pre-populate a new company row.
export const inferATSFromPostingURL = async (postingURL) => {
  if (!postingURL) return { atsURL: '', provider: '' };
  let u;
  try { u = new URL(postingURL); }
  catch { return { atsURL: '', provider: '' }; }
  const host = u.hostname.toLowerCase();
  const providers = await loadProviders();
  for (const p of providers) {
    if (!p.hostRegex.test(host)) continue;
    let atsPath = '';
    if (p.slugInPath && p.searchHosts.includes(host)) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 1) atsPath = '/' + parts[0];
    }
    return { atsURL: `${u.protocol}//${host}${atsPath}`, provider: p.provider };
  }
  return { atsURL: '', provider: '' };
};

// fetchATSPosting tries the browser-directly ATS extractors for the URL and
// returns the first that succeeds with a structured posting object, or null.
// Greenhouse and Lever expose CORS-open public APIs; Ashby's HTML is
// cross-origin blocked and typically falls through here.
export const fetchATSPosting = async (url) => {
  if (greenhouseSupports(url)) return await greenhouseFetch(url);
  if (leverSupports(url))      return await leverFetch(url);
  if (ashbySupports(url))      return await ashbyFetch(url);
  return null;
};

// Providers that ship a browser-side structured extractor. Anything else
// in ats-providers.json has host_pattern but no fetcher, so we can't
// triage their URLs beyond the generic fallback.
const STRUCTURED_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby']);

// isATSLandingPage mirrors ats.Registry.IsLandingPage: URL is on a host
// served by one of STRUCTURED_PROVIDERS but no supports() matches — i.e.
// tenant landing page, not a specific posting. Pre-filters use this to
// skip URLs that would only fetch to a 404.
export const isATSLandingPage = async (rawURL) => {
  if (!rawURL) return false;
  let u;
  try { u = new URL(String(rawURL).trim()); } catch { return false; }
  const host = u.hostname.toLowerCase();
  const providers = await loadProviders();
  const hostKnown = providers.some((p) => STRUCTURED_PROVIDERS.has(p.provider) && p.hostRegex.test(host));
  if (!hostKnown) return false;
  return !(greenhouseSupports(rawURL) || leverSupports(rawURL) || ashbySupports(rawURL));
};
