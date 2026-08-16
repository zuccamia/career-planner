// Greenhouse posting fetcher. Ports internal/sources/ats/greenhouse.go —
// hits Greenhouse's public boards API directly from the browser (CORS-open).

const API_BASE = 'https://boards-api.greenhouse.io';

const parseURL = (raw) => {
  let u;
  try { u = new URL((raw ?? '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host !== 'boards.greenhouse.io' && host !== 'job-boards.greenhouse.io') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[1] !== 'jobs' || !parts[0] || !parts[2]) return null;
  return { board: parts[0], id: parts[2] };
};

export const supports = (url) => parseURL(url) !== null;

// htmlToText strips tags and collapses whitespace. Server does the same
// (internal/sources/ats/html.go) — matched here so the snippet the ranker
// sees is shaped the same both server-side and BYOK.
const htmlToText = (html) => {
  const decoded = String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${decoded}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};

export const fetchPosting = async (rawURL, { timeoutMs = 15_000 } = {}) => {
  const parsed = parseURL(rawURL);
  if (!parsed) return null;
  const apiURL = `${API_BASE}/v1/boards/${encodeURIComponent(parsed.board)}/jobs/${encodeURIComponent(parsed.id)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiURL, { headers: { Accept: 'application/json' }, signal: controller.signal });
    // 404/410 = posting definitely gone. Signal distinctly so the caller
    // drops the URL rather than surfacing a dead link.
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) return null;
    const payload = await res.json();
    const desc = htmlToText(payload.content || '');
    if (!(payload.title || '').trim()) return null;
    const postedAt = payload.first_published || payload.updated_at || '';
    return {
      title: (payload.title || '').trim(),
      url: (payload.absolute_url || rawURL).trim(),
      company: (payload.company_name || '').trim(),
      location: (payload.location?.name || '').trim(),
      department: (payload.departments?.[0]?.name || '').trim(),
      snippet: desc,
      postedAt: postedAt ? new Date(postedAt).toISOString() : '',
      provider: 'greenhouse',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
