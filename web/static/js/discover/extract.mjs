// Dispatches a hit to the right ATS extractor. Matches the server's
// extractPostings semantics: hits on known providers try that provider's
// fetcher; anything else uses the generic fallback. The returned shape is
// the JobPosting the server's discover-rank prompt reads
// (title/url/company/snippet/source/location/employment_type) plus
// board_url/provider/posted_at which the client re-attaches to
// Recommendation after the server strips them (json:"-").

import { fetchPosting as greenhouseFetch, supports as greenhouseSupports } from '../sources/ats/greenhouse.mjs';
import { fetchPosting as leverFetch, supports as leverSupports } from '../sources/ats/lever.mjs';
import { fetchPosting as ashbyFetch, supports as ashbySupports } from '../sources/ats/ashby.mjs';
import { fetchPosting as genericFetch } from '../sources/ats/generic.mjs';

const pickExtractor = (url) => {
  if (greenhouseSupports(url)) return { fetch: greenhouseFetch, provider: 'greenhouse' };
  if (leverSupports(url))      return { fetch: leverFetch,      provider: 'lever' };
  if (ashbySupports(url))      return { fetch: ashbyFetch,      provider: 'ashby' };
  return { fetch: genericFetch, provider: 'generic' };
};


// buildPosting normalizes a hit + optional extractor result into the
// JobPosting shape the rank prompt reads. Callers pass:
//   source     — one of 'search' | <provider name>
//   hit        — the SearchHit that seeded this posting
//   posting    — extractor result (or null when we're falling back)
//   pickedProv — provider label from pickExtractor, used when posting is null
const buildPosting = (source, hit, posting, pickedProv) => ({
  title: posting?.title || hit.title || '',
  url: posting?.url || hit.url,
  company: posting?.company || '',
  source,
  snippet: posting?.snippet || hit.snippet || '',
  location: posting?.location || '',
  employment_type: posting?.employmentType || '',
  board_url: hit.board_url || '',
  provider: posting?.provider || hit.provider || pickedProv,
  posted_at: posting?.postedAt || hit.published_at || '',
});

// { gone: true } → drop and remember; null → degrade to search snippet;
// object → structured posting.
const extractPosting = async (hit, gone) => {
  const picked = pickExtractor(hit.url);
  const posting = await picked.fetch(hit.url).catch(() => null);
  if (posting && posting.gone) {
    gone?.add(hit.url);
    return { dropped: 'gone' };
  }
  if (posting) return { posting: buildPosting(posting.provider || picked.provider, hit, posting, picked.provider) };
  return { posting: buildPosting('search', hit, null, picked.provider === 'generic' ? '' : picked.provider) };
};

// budget targets SURVIVORS, not attempts: gone URLs cost a fetch slot but
// don't consume a budget slot. Runs in batches of `concurrency`, stops
// early once budget survivors accumulate. Returns { postings, goneNew }.
export const extractPostings = async (hits, { budget = 40, concurrency = 5, gone = null } = {}) => {
  if (budget <= 0 || !hits?.length) return { postings: [], goneNew: 0 };
  const postings = [];
  let goneNew = 0;
  for (let i = 0; i < hits.length && postings.length < budget; i += concurrency) {
    const batch = hits.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((h) => extractPosting(h, gone)));
    for (const r of results) {
      if (r?.dropped === 'gone') { goneNew++; continue; }
      if (r?.posting && postings.length < budget) postings.push(r.posting);
    }
  }
  return { postings, goneNew };
};
