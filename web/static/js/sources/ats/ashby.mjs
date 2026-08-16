// Ashby posting fetcher. Server-side (internal/sources/ats/ashby.go) scrapes
// the JobPosting JSON-LD block from the HTML page. Browser can't fetch that
// page cross-origin — Ashby doesn't send CORS. Falls through to generic
// (BYOK scraper or plain fetch attempt).

const parseURL = (raw) => {
  let u;
  try { u = new URL((raw ?? '').trim()); } catch { return null; }
  if (u.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { org: parts[0], id: parts[1] };
};

export const supports = (url) => parseURL(url) !== null;

// findJobPostingJSONLD scans HTML for <script type="application/ld+json">
// blocks and returns the first JobPosting object. Mirrors the Go extractor.
export const findJobPostingJSONLD = (html) => {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of arr) {
      if (item && String(item['@type'] || '').toLowerCase() === 'jobposting') return item;
    }
  }
  return null;
};

const placeToString = (p) => {
  if (!p) return '';
  const parts = [p.address?.addressLocality, p.address?.addressRegion, p.address?.addressCountry]
    .map((s) => (s || '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : (p.name || '').trim();
};

const formatLocation = (raw) => {
  if (!raw) return '';
  if (Array.isArray(raw)) return placeToString(raw[0]);
  return placeToString(raw);
};

// trimFloat renders an integer float without a trailing ".0" but keeps
// non-integer floats intact. Mirrors Go's trimFloat helper.
const trimFloat = (n) => Number.isFinite(n) ? String(n) : '';

// formatSalary renders schema.org MonetaryAmount as "USD 11000/month" or
// "USD 98000-131000/year". Empty when min and max are both zero. Mirrors
// Go's formatSalary in ashby.go.
const formatSalary = (base) => {
  if (!base) return '';
  const value = base.value || {};
  const minValue = Number(value.minValue) || 0;
  const maxValue = Number(value.maxValue) || 0;
  if (minValue === 0 && maxValue === 0) return '';
  const amount = minValue === maxValue
    ? trimFloat(minValue)
    : `${trimFloat(minValue)}-${trimFloat(maxValue)}`;
  const currency = (base.currency || '').trim();
  const unit = (value.unitText || '').trim().toLowerCase();
  let out = amount;
  if (currency) out = `${currency} ${out}`;
  if (unit) out = `${out}/${unit}`;
  return out;
};

const htmlToText = (html) => {
  const stripped = String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${stripped}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};

// extractFromHTML parses a fetched Ashby posting page. Exposed so the
// generic fallback (BYOK scraper) can hand its scraped HTML back to us
// after retrieving the page.
export const extractFromHTML = (html, sourceURL) => {
  const jp = findJobPostingJSONLD(html);
  if (!jp) return null;
  const title = (jp.title || '').trim();
  if (!title) return null;
  return {
    title,
    url: sourceURL,
    company: (jp.hiringOrganization?.name || '').trim(),
    location: formatLocation(jp.jobLocation),
    snippet: htmlToText(jp.description || ''),
    postedAt: jp.datePosted ? new Date(jp.datePosted).toISOString() : '',
    provider: 'ashby',
    employmentType: (jp.employmentType || '').trim(),
    compensation: formatSalary(jp.baseSalary),
  };
};

// fetchPosting attempts a direct fetch of the HTML page (usually blocked by
// CORS). Returns null on failure so the caller falls through to the
// scraper-based generic path.
export const fetchPosting = async (rawURL, { timeoutMs = 15_000 } = {}) => {
  if (!parseURL(rawURL)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rawURL, { signal: controller.signal });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) return null;
    const html = await res.text();
    return extractFromHTML(html, rawURL);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
