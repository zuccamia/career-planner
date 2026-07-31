// Browser mirror of internal/sources/ats/discover.go. Given a company's main
// URL, calls the configured scraper's map/scan endpoint and filters returned
// URLs against known ATS host patterns. Called from the dossier flow when the
// user provided `website` but no `ats_url` and BYOK scraping is active.
//
// Pattern list is intentionally duplicated with the Go side (short, stable);
// keeping them in sync is a one-line edit if we ever add a new provider.

import { mapDomain } from './scrape-client.mjs';

const patterns = [
  { provider: 'greenhouse',        rx: /^(job-)?boards\.greenhouse\.io$|\.greenhouse\.io$/i },
  { provider: 'lever',             rx: /^jobs\.lever\.co$/i },
  { provider: 'ashby',             rx: /\.ashbyhq\.com$|^jobs\.ashbyhq\.com$/i },
  { provider: 'workday',           rx: /\.myworkdayjobs\.com$/i },
  { provider: 'smartrecruiters',   rx: /^jobs\.smartrecruiters\.com$/i },
  { provider: 'careers-subdomain', rx: /^careers\./i },
];

const hostOf = (u) => {
  try { return new URL(u).hostname; }
  catch { return ''; }
};

// Returns { atsURL, provider } on first match, or { atsURL: '', provider: '' }
// on no match. An absence of ATS is not an error.
export const discoverATSURL = async (companyWebsite) => {
  if (!companyWebsite) return { atsURL: '', provider: '' };
  const res = await mapDomain(companyWebsite);
  for (const u of res.urls || []) {
    const host = hostOf(u);
    if (!host) continue;
    for (const p of patterns) {
      if (p.rx.test(host)) return { atsURL: u, provider: p.provider };
    }
  }
  return { atsURL: '', provider: '' };
};
