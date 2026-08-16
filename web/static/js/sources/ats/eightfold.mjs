// Eightfold posting fetcher. Mirrors internal/sources/ats/eightfold.go —
// hits the public position API since the HTML page is a SPA shell.

import { prettifySlug } from '../../ui/format.mjs';

const PATH_RE = /^\/careers\/job\/(\d+)/;

const parseURL = (raw) => {
  let u;
  try { u = new URL((raw ?? '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith('.eightfold.ai')) return null;
  const tenant = host.slice(0, -'.eightfold.ai'.length);
  if (!tenant) return null;
  const m = PATH_RE.exec(u.pathname);
  if (!m) return null;
  return { tenant, jobID: m[1], domain: u.searchParams.get('domain') || '' };
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

export const fetchPosting = async (rawURL, { timeoutMs = 15_000 } = {}) => {
  const parsed = parseURL(rawURL);
  if (!parsed) return null;
  const qs = parsed.domain ? `?domain=${encodeURIComponent(parsed.domain)}` : '';
  const apiURL = `https://${parsed.tenant}.eightfold.ai/api/apply/v2/jobs/${encodeURIComponent(parsed.jobID)}${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiURL, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) return null;
    const payload = await res.json();
    const title = (payload.name || payload.posting_name || '').trim();
    if (!title) return null;
    const desc = htmlToText(payload.job_description || payload.custom_JD || '');
    if (!desc) return null;
    const locations = Array.isArray(payload.locations) && payload.locations.length
      ? payload.locations.join('; ')
      : (payload.location || '').trim();
    const postedAt = payload.t_create > 0
      ? new Date(payload.t_create * 1000).toISOString()
      : '';
    return {
      title,
      url: (payload.canonicalPositionUrl || rawURL).trim(),
      company: prettifySlug(parsed.tenant),
      location: locations,
      department: (payload.department || '').trim(),
      team: (payload.business_unit || '').trim(),
      snippet: desc,
      postedAt,
      provider: 'eightfold',
      employmentType: (payload.type || '').trim(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
