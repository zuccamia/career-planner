// Workable posting fetcher. Mirrors internal/sources/ats/workable.go — hits
// the tenant's public markdown endpoint (`.md`) instead of the HTML shell
// (which is cookie-banner-gated).

const PATH_RE = /^\/([^/]+)\/j\/([^/]+)/;
const TITLE_RE = /^#\s+(.+?)\s*$/m;
const BLOCKQUOTE_RE = /^>\s+(.+?)\s*$/m;
const FIELD_RE = /^\*\*([^*]+):\*\*\s+(.+?)\s*$/gm;
const DESC_RE = /^##\s+Description\s*$\s*([\s\S]+)$/m;
const POSTED_RE = /^Posted\s+(\d{4}-\d{2}-\d{2})/;

const CONTRACT_TYPES = new Set([
  'Contract', 'Full-time', 'Part-time', 'Full time', 'Part time',
  'Intern', 'Internship', 'Temporary', 'Freelance',
]);

const parseURL = (raw) => {
  let u;
  try { u = new URL((raw ?? '').trim()); } catch { return null; }
  if (u.hostname.toLowerCase() !== 'apply.workable.com') return null;
  const m = PATH_RE.exec(u.pathname);
  if (!m) return null;
  return { tenant: m[1], code: m[2] };
};

export const supports = (url) => parseURL(url) !== null;

const parseMarkdown = (md, applyURL) => {
  const titleM = TITLE_RE.exec(md);
  const title = titleM ? titleM[1].trim() : '';
  if (!title) return null;
  const posting = {
    title,
    url: applyURL,
    company: '',
    location: '',
    department: '',
    team: '',
    snippet: '',
    postedAt: '',
    provider: 'workable',
    employmentType: '',
  };

  const bqM = BLOCKQUOTE_RE.exec(md);
  if (bqM) {
    const parts = bqM[1].split('·').map(s => s.trim());
    if (parts.length > 0) posting.company = parts[0];
    const locParts = [];
    for (const part of parts.slice(1)) {
      const pM = POSTED_RE.exec(part);
      if (pM) { posting.postedAt = pM[1]; continue; }
      if (CONTRACT_TYPES.has(part)) { posting.employmentType = part; continue; }
      locParts.push(part);
    }
    posting.location = locParts.join(', ');
  }

  // Prepend Remote/Hybrid to location if the workplace field signals it.
  for (const m of md.matchAll(FIELD_RE)) {
    if (m[1].trim().toLowerCase() !== 'workplace') continue;
    const v = m[2].trim().toLowerCase();
    if (v === 'remote') {
      posting.location = posting.location ? `Remote — ${posting.location}` : 'Remote';
    } else if (v === 'hybrid') {
      posting.location = posting.location ? `Hybrid — ${posting.location}` : 'Hybrid';
    }
  }

  const descM = DESC_RE.exec(md);
  posting.snippet = (descM ? descM[1] : md).trim();
  if (!posting.snippet) return null;
  return posting;
};

export const fetchPosting = async (rawURL, { timeoutMs = 15_000 } = {}) => {
  const parsed = parseURL(rawURL);
  if (!parsed) return null;
  const mdURL = `https://apply.workable.com/${encodeURIComponent(parsed.tenant)}/jobs/view/${encodeURIComponent(parsed.code)}.md`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(mdURL, {
      headers: { Accept: 'text/markdown, text/plain' },
      signal: controller.signal,
    });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) return null;
    const md = await res.text();
    return parseMarkdown(md, rawURL);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
