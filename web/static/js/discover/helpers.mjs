// Cross-file utilities mirroring internal/discover/helpers.go: URL
// normalization, employment-type table, freshness filter, HTTP status
// probe + dead-link filter, past-cycle URL heuristic, time anchors.

// employmentTitleKeywords maps `looking_for` to title-frequency OR-groups.
// Only cycle-driven types (internship, new-grad) have entries — for
// full_time / contract / open the modifier rarely appears in titles.
export const employmentTitleKeywords = {
  internship: ['intern', 'internship', 'co-op'],
  new_grad: ['new grad', 'new graduate', 'entry level'],
};

// isScarceEmployment: role's posting pool is small and cycle-driven.
// Callers loosen behavior (wider stale window, broader query).
export const isScarceEmployment = (employmentType) => employmentType in employmentTitleKeywords;

// nowLocal is a package var so tests can freeze time. Local (not UTC)
// so the year window matches the user's calendar.
export let nowLocal = () => new Date();

// targetHireMonth: nominal "when hiring should land" — now + 9 months.
// Anchor for seasonalYears (search query) and isPastCycleURL (pre-filter).
export const targetHireMonth = () => {
  const t = nowLocal();
  t.setMonth(t.getMonth() + 9);
  return t;
};

// normalizeURL returns a stable dedup key: registrable-domain host (last
// two labels — collapses subdomain drift), lowercased scheme, query
// dropped, fragment stripped, trailing slash trimmed. Mirrors helpers.go
// — query is dropped wholesale since job boards identify postings via
// path and any query is tracking.
export const normalizeURL = (raw) => {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  let u;
  try { u = new URL(trimmed); } catch { return trimmed.toLowerCase(); }
  if (!u.host) return trimmed.toLowerCase();
  const labels = u.host.toLowerCase().split('.');
  u.host = labels.length < 2 ? labels[0] : labels[labels.length - 2] + '.' + labels[labels.length - 1];
  u.hash = '';
  u.search = '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
};

// Staleness windows — scarce roles get a wider window since fresh postings
// are cyclical. Mirrors staleScarceDays/staleDefaultDays in service.go.
const STALE_SCARCE_DAYS = 90;
const STALE_DEFAULT_DAYS = 30;

// filterStalePostings drops postings whose postedAt is older than the budget.
// Missing/zero postedAt passes through — better to over-include than to
// silently drop a valid recent posting.
export const filterStalePostings = (postings, employmentType) => {
  const maxAge = isScarceEmployment(employmentType) ? STALE_SCARCE_DAYS : STALE_DEFAULT_DAYS;
  const cutoff = Date.now() - maxAge * 86_400_000;
  return postings.filter((p) => {
    if (!p.posted_at) return true;
    const t = new Date(p.posted_at).getTime();
    if (!Number.isFinite(t) || t <= 0) return true;
    return t >= cutoff;
  });
};

// collectBrowserHits flattens per-host BYOK search results into a single hit
// list, deduping by normalized URL. Mirrors internal/discover/helpers.go
// collectBrowserHits.
export const collectBrowserHits = (groups) => {
  const seen = new Set();
  const out = [];
  for (const g of groups || []) {
    for (const r of g.results || []) {
      const key = normalizeURL(r.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        url: r.url,
        title: r.title || '',
        snippet: r.content || '',
        engine: r.engine || '',
        published_at: r.published_at || '',
        board_url: g.board_url || '',
        provider: g.provider || '',
      });
    }
  }
  return out;
};

// probeHTTPStatus returns true when a URL is deterministically dead
// (unparseable, 404, or 410). Best-effort: transport errors, timeouts,
// and opaque responses return false (keep the rec). Mirrors
// probeHTTPStatus in extract.go.
export const probeHTTPStatus = async (url, { timeoutMs = 3000 } = {}) => {
  try { new URL(url); } catch { return true; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', mode: 'no-cors', redirect: 'follow', signal: controller.signal });
    // Opaque responses (mode: 'no-cors') expose status 0 — can't tell,
    // so trust the URL.
    if (res.type === 'opaque' || res.status === 0) return false;
    return res.status === 404 || res.status === 410;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

// isolatedYear matches a 20xx year with non-digit boundaries. Works for
// URL slugs and titles; job IDs and internal digits don't match.
const isolatedYear = /(?:^|\D)(20\d{2})(?:\D|$)/g;

// isPastCycle: max isolated year in text is earlier than target hire
// year. Callers concatenate URL + Title.
export const isPastCycle = (text) => {
  let maxYear = 0;
  for (const m of String(text || '').matchAll(isolatedYear)) {
    const y = Number(m[1]);
    if (Number.isFinite(y) && y > maxYear) maxYear = y;
  }
  return maxYear > 0 && maxYear < targetHireMonth().getFullYear();
};

// preFilterHits mirrors the server's preFilterHits: cheap syntactic
// drops (dedupe / ATS landing / gone cache / past cycle) applied before
// extract budget. isATSLandingPage passed as callback so this file
// stays free of the ATS module. Returns { hits, counts }.
export const preFilterHits = async (hits, existing, isATSLandingPage, gone) => {
  const out = [];
  const counts = { dedupe: 0, shape: 0, goneCached: 0, pastCycle: 0 };
  for (const h of hits || []) {
    const key = normalizeURL(h.url);
    if (!key) continue;
    if (existing.has(key)) { counts.dedupe++; continue; }
    if (isATSLandingPage && await isATSLandingPage(h.url)) { counts.shape++; continue; }
    if (gone?.has(h.url)) { counts.goneCached++; continue; }
    if (isPastCycle(`${h.url} ${h.title || ''}`)) { counts.pastCycle++; continue; }
    out.push(h);
  }
  return { hits: out, counts };
};

// filterDeadLinks HEAD-checks recs in parallel and drops any known-dead.
// gone (optional) receives every dropped URL for the next Run's pre-filter.
export const filterDeadLinks = async (recs, gone = null) => {
  if (!recs || recs.length === 0) return recs || [];
  const deadFlags = await Promise.all(recs.map((r) => probeHTTPStatus(r.url)));
  const out = [];
  for (let i = 0; i < recs.length; i++) {
    if (!deadFlags[i]) out.push(recs[i]);
    else gone?.add(recs[i].url);
  }
  return out;
};

// --- goneCache -----------------------------------------------------

// Page-lifetime memo of URLs confirmed 404 by extract or HEAD-filter.
// FIFO evict-half on overflow. Mirrors internal/discover/prefilter.go
// goneCache (which is process-lifetime; browser is per-page-load).
const GONE_CACHE_CAP = 256;

export const makeGoneCache = () => {
  const seen = new Set();
  const order = [];
  return {
    add(url) {
      const key = (url ?? '').trim();
      if (!key || seen.has(key)) return;
      if (order.length >= GONE_CACHE_CAP) {
        const half = order.length >> 1;
        for (let i = 0; i < half; i++) seen.delete(order[i]);
        order.splice(0, half);
      }
      seen.add(key);
      order.push(key);
    },
    has(url) { return seen.has((url ?? '').trim()); },
  };
};

// Singleton shared across all runs in one page load.
export const goneCache = makeGoneCache();
