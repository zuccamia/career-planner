// SmartRecruiters posting fetcher. Mirrors internal/sources/ats/smartrecruiters.go —
// hits the public jobs API since the HTML page is scraper-hostile.

const PATH_RE = /^\/([^/]+)\/(\d+)/;

const parseURL = (raw) => {
  let u;
  try { u = new URL((raw ?? '').trim()); } catch { return null; }
  if (u.hostname.toLowerCase() !== 'jobs.smartrecruiters.com') return null;
  const m = PATH_RE.exec(u.pathname);
  if (!m) return null;
  return { tenant: m[1], postingID: m[2] };
};

export const supports = (url) => parseURL(url) !== null;

const htmlToText = (html) => {
  const stripped = String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${stripped}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};

const formatLocation = (loc) => {
  if (!loc) return '';
  const parts = [loc.city, loc.region, (loc.country || '').toUpperCase()]
    .map(s => (s || '').trim())
    .filter(Boolean);
  const base = parts.join(', ') || (loc.fullLocation || '').replace(/^,\s*|,\s*$/g, '').trim();
  if (loc.remote) return base ? `Remote — ${base}` : 'Remote';
  if (loc.hybrid) return base ? `Hybrid — ${base}` : 'Hybrid';
  return base;
};

export const fetchPosting = async (rawURL, { timeoutMs = 15_000 } = {}) => {
  const parsed = parseURL(rawURL);
  if (!parsed) return null;
  const apiURL = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(parsed.tenant)}/postings/${encodeURIComponent(parsed.postingID)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiURL, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) return null;
    const payload = await res.json();
    const title = (payload.name || '').trim();
    if (!title) return null;
    const sections = payload.jobAd?.sections || {};
    const order = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'];
    const parts = [];
    for (const k of order) {
      const sec = sections[k];
      if (!sec?.text) continue;
      if (sec.title) parts.push(`<h3>${sec.title}</h3>`);
      parts.push(sec.text);
    }
    const desc = htmlToText(parts.join('\n'));
    if (!desc) return null;
    return {
      title,
      url: (payload.applyUrl || rawURL).trim(),
      company: (payload.company?.name || '').trim(),
      location: formatLocation(payload.location),
      department: '',
      team: '',
      snippet: desc,
      postedAt: (payload.releasedDate || '').trim(),
      provider: 'smartrecruiters',
      employmentType: (payload.typeOfEmployment?.label || '').trim(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
