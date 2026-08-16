// Generic posting fetcher for hosts we don't have a structured extractor for.
// Preference order: BYOK browser scraper, then the server /api/scrape/posting
// endpoint (uses the server scraper + ATS registry), then a plain fetch.
// Returns null when nothing yields text; the caller falls back to using the
// search snippet as the ranker's only signal.

import { isByokScraperActive } from '../../storage/byok-scraper.mjs';
import { scrape, getServerScraperStatus } from '../../scrape-client.mjs';
import { isStaticHost } from '../../host.mjs';
import { fetchJSON } from '../../fetch-helpers.mjs';
import { extractFromHTML as ashbyExtract } from './ashby.mjs';

const htmlToText = (html) => {
  const stripped = String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${stripped}</body>`, 'text/html');
  const title = doc.head?.querySelector('title')?.textContent || '';
  const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  return { title: title.trim(), text };
};

const tryPlainFetch = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
};

// fetchPosting tries BYOK scraper, then server /api/scrape/posting, then a
// plain fetch. Ashby URLs pass their fetched HTML through the structured
// JSON-LD extractor so the ranker gets clean fields.
export const fetchPosting = async (rawURL, { timeoutMs = 30_000 } = {}) => {
  let html = '';
  let markdown = '';
  if (await isByokScraperActive()) {
    try {
      const res = await scrape(rawURL, { formats: ['markdown', 'html'] });
      html = res.html || '';
      markdown = res.markdown || '';
    } catch {
      return null;
    }
  } else if (!isStaticHost() && (await getServerScraperStatus()).available) {
    try {
      const body = await fetchJSON('/api/applications/scrape', { body: { job_posting_url: rawURL } });
      const posting = body.posting || {};
      return {
        title: (posting.title || '').trim(),
        url: (posting.apply_url || rawURL).trim(),
        company: (posting.company || '').trim(),
        location: (posting.location || '').trim(),
        department: (posting.department || '').trim(),
        team: (posting.team || '').trim(),
        snippet: (body.enriched_raw || '').trim(),
        postedAt: posting.posted_at || '',
        provider: (posting.provider || '').trim(),
        employmentType: (posting.employment_type || '').trim(),
        compensation: (posting.compensation || '').trim(),
      };
    } catch {
      return null;
    }
  } else {
    html = await tryPlainFetch(rawURL, Math.min(timeoutMs, 10_000));
    if (!html) return null;
  }

  try {
    const u = new URL(rawURL);
    if (u.hostname.toLowerCase() === 'jobs.ashbyhq.com' && html) {
      const jp = ashbyExtract(html, rawURL);
      if (jp) return jp;
    }
  } catch { /* fall through */ }

  const { title, text } = html ? htmlToText(html) : { title: '', text: markdown.replace(/\s+/g, ' ').trim() };
  if (!text) return null;
  return {
    title,
    url: rawURL,
    company: '',
    location: '',
    department: '',
    team: '',
    snippet: text.slice(0, 4000),
    postedAt: '',
    provider: 'generic',
    employmentType: '',
    compensation: '',
  };
};

export const supports = () => true;
