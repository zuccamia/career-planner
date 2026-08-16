// Lever posting fetcher. Ports internal/sources/ats/lever.go — hits Lever's
// public postings API directly from the browser (CORS-open).

import { prettifySlug } from '../../ui/format.mjs';

const API_BASE = 'https://api.lever.co';

const parseURL = (raw) => {
  let u;
  try { u = new URL((raw ?? '').trim()); } catch { return null; }
  if (u.hostname.toLowerCase() !== 'jobs.lever.co') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { company: parts[0], id: parts[1] };
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
  const apiURL = `${API_BASE}/v0/postings/${encodeURIComponent(parsed.company)}/${encodeURIComponent(parsed.id)}?mode=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiURL, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) return null;
    const payload = await res.json();
    if (!(payload.text || '').trim()) return null;
    const parts = [];
    if (payload.description) parts.push(payload.description);
    for (const s of payload.lists || []) {
      if (s.text) parts.push(`<h3>${s.text}</h3>`);
      if (s.content) parts.push(s.content);
    }
    if (payload.additional) parts.push(payload.additional);
    const desc = htmlToText(parts.join('\n'));
    const postedAt = payload.createdAt > 0 ? new Date(payload.createdAt).toISOString() : '';
    const team = (payload.categories?.team || '').trim();
    const department = (payload.categories?.department || '').trim() || team;
    return {
      title: (payload.text || '').trim(),
      url: (payload.applyUrl || payload.hostedUrl || rawURL).trim(),
      company: prettifySlug(parsed.company),
      location: (payload.categories?.location || '').trim(),
      department,
      team,
      snippet: desc,
      postedAt,
      provider: 'lever',
      employmentType: (payload.categories?.commitment || '').trim(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
