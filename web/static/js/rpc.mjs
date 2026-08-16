// Thin JSON-over-HTTP client for the Go RPC surface. See
// docs/deployment-matrix.md for the routing rule; onStep callbacks emit
// {name, status: 'running'|'done'|'failed', error?} for the progress UI.

import { isByokLLMActive, getByokLLMConfig } from './storage/byok-llm.mjs';
import { isByokScraperActive } from './storage/byok-scraper.mjs';
import { scrapeWithCache, scrapeInParallel } from './scrape-with-cache.mjs';
import { lookupATSURL, fetchATSPosting, hasBrowserATSFetcher } from './ats-lookup.mjs';
import { callOpenAICompatible, getServerLLMStatus } from './llm-client.mjs';
import { getServerScraperStatus } from './scrape-client.mjs';
import { currentLocale, t } from './i18n.mjs';
import { isStaticHost } from './host.mjs';
import { builders, parsers } from './llm/parse/index.mjs';
import { fetchJSON } from './fetch-helpers.mjs';
import { stepped, noopStep } from './ui/progress.mjs';

const DOSSIER_SCRAPE_TTL_SECONDS = 24 * 3600;
const JD_SCRAPE_TTL_SECONDS = 3600;

// post is a POST shorthand over the shared fetchJSON helper.
const post = (url, body) => fetchJSON(url, { body });

const llmCall = async (name, input, serverPath, outputLanguage, onStep = noopStep) => {
  const lang = outputLanguage || currentLocale();
  const withLang = { ...input, output_language: lang };
  const byokLLMActive = await isByokLLMActive();

  if (byokLLMActive) {
    // All three LLM steps run client-side: prompt assembly via builders[name],
    // the provider call via callOpenAICompatible, and response parsing via
    // parsers[name]. Builders and parsers in llm/parse/*.mjs mirror the Go
    // build/finalize helpers inside each service. When the caller needs
    // scrape/ATS content (buildDossier, extractJobDescription), it runs that
    // step before invoking llmCall.
    const cfg = await getByokLLMConfig();
    const { system, user, ...extras } = await stepped(onStep, 'prompt', () => builders[name](withLang, lang));
    const raw = await stepped(onStep, 'generate', () => callOpenAICompatible({ system, user }, cfg));
    return stepped(onStep, 'parse', () => Promise.resolve(parsers[name](raw, { input: withLang, ...extras })));
  }

  // getServerLLMStatus short-circuits to unavailable on static host, so this
  // one check covers both "static build, no server" and "hosted but no key."
  const serverLLM = await getServerLLMStatus();
  if (!serverLLM.available) throw new Error(t('settings.ai.error.no_llm_configured'));

  const mayServerScrape = name === 'build-dossier' || name === 'extract-job-description';
  const serverScrapeHint = mayServerScrape && (await getServerScraperStatus()).available
    ? 'progress.hint.server_scrape'
    : undefined;
  return stepped(onStep, 'generate', () => post(serverPath, withLang), serverScrapeHint);
};

// Ask the Go LLM pipeline to guess a canonical Company row from a typed name.
// Returns { candidate: {official_name, website, blog_url, ats_url, ats_provider, reasoning}, warning? }.
export const guessCompanyCandidate = (name, outputLanguage, onStep) =>
  llmCall('guess-candidate', { name }, '/api/companies/guess-candidate', outputLanguage, onStep);

// Extract structured facts from raw JD text. When job_description_raw is
// empty and job_posting_url is set, the source is fetched: browser BYOK
// scraper first, else /api/applications/scrape when BYOK LLM is active, else
// let the server-side /api/applications/extract-job-description flow do it.
// Static host with no BYOK scraper is a hard error surfaced via the scrape step.
export const extractJobDescription = async (input, outputLanguage, onStep = noopStep) => {
  const payload = { ...input };
  const url = (input.job_posting_url || '').trim();
  const rawEmpty = !(input.job_description_raw || '').trim();
  if (rawEmpty && !url) throw new Error(t('applications.error.jd_input_required'));

  if (rawEmpty && url) {
    // Preferred client-side path for known ATS URLs: Greenhouse and Lever
    // expose CORS-open APIs; a success populates posting for LLM overlay.
    // Ashby's HTML is CORS-blocked so the call typically returns null and we
    // fall through to the scraper. Gate the progress step on
    // hasBrowserATSFetcher so URLs without an extractor don't render a
    // misleading "ATS fetch ✓"; and on a real error (network / provider API
    // change) let stepped emit `failed` while we still fall through.
    if (hasBrowserATSFetcher(url)) {
      try {
        const atsPosting = await stepped(onStep, 'ats_fetch',
          () => fetchATSPosting(url),
          { emptyIf: (r) => !r?.snippet },
        );
        if (atsPosting?.snippet) {
          payload.job_description_raw = atsPosting.snippet;
          payload.posting = atsPosting;
        }
      } catch (err) {
        console.warn('extractJobDescription: ats_fetch failed, falling through to scraper:', err);
      }
    }

    if (!payload.job_description_raw) {
      if (await isByokScraperActive()) {
        const md = await scrapeWithCache(url, { ttlSeconds: JD_SCRAPE_TTL_SECONDS, stepName: 'scrape', onStep });
        if (md) payload.job_description_raw = md;
      } else if (await isByokLLMActive() && !isStaticHost() && (await getServerScraperStatus()).available) {
        const scraped = await stepped(onStep, 'scrape', () => post('/api/applications/scrape', {
          job_posting_url: url,
          output_language: outputLanguage || currentLocale(),
        }), 'progress.hint.server_scrape');
        payload.job_description_raw = scraped.enriched_raw || '';
        payload.posting = scraped.posting || {};
      } else if (isStaticHost()) {
        onStep({ name: 'scrape', status: 'failed', error: t('applications.error.jd_scraper_required_static') });
      }
    }
  }
  return llmCall('extract-job-description', payload, '/api/applications/extract-job-description', outputLanguage, onStep);
};

// Build a dossier. Scrape preference: BYOK browser scraper (best; also runs
// ATS look-up from the domain map), else /api/dossiers/scrape when BYOK
// LLM is active, else no enrichment (a thinner dossier, surface a warning).
// Failures at any step are non-fatal; the dossier builds from whatever
// succeeded plus the structured fields.
export const buildDossier = async (company, outputLanguage, onStep = noopStep) => {
  const payload = { ...company };
  const website = (company.website || '').trim();
  const blogURL = (company.blog_url || '').trim();
  const atsURL  = (company.ats_url || '').trim();
  const anyURL  = website || blogURL || atsURL;

  if (await isByokScraperActive()) {
    if (website && !payload.ats_url) {
      try {
        const match = await stepped(onStep, 'lookup', () => lookupATSURL(website));
        if (match.atsURL) {
          payload.ats_url = match.atsURL;
          if (!payload.ats_provider && match.provider) payload.ats_provider = match.provider;
        }
      } catch (err) {
        console.warn('buildDossier: ATS look-up failed:', err);
      }
    }
    const scrapedContent = await scrapeInParallel([
      { stepName: 'scrape_website', url: website,         key: 'website_content' },
      { stepName: 'scrape_blog',    url: blogURL,         key: 'blog_content'    },
      { stepName: 'scrape_careers', url: payload.ats_url, key: 'careers_content' },
    ], { ttlSeconds: DOSSIER_SCRAPE_TTL_SECONDS, onStep });
    Object.assign(payload, scrapedContent);
  } else if (anyURL && await isByokLLMActive() && !isStaticHost() && (await getServerScraperStatus()).available) {
    const scraped = await stepped(onStep, 'scrape', () => post('/api/dossiers/scrape', {
      website, blog_url: blogURL, ats_url: atsURL, ats_provider: payload.ats_provider || '',
    }), 'progress.hint.server_scrape');
    Object.assign(payload, {
      ats_url: scraped.ats_url,
      ats_provider: scraped.ats_provider,
      website_content: scraped.website_content,
      blog_content: scraped.blog_content,
      careers_content: scraped.careers_content,
    });
  } else if (anyURL) {
    onStep({ name: 'scrape', status: 'failed', error: t('dossiers.warning.scraper_recommended') });
  }

  return llmCall('build-dossier', payload, '/api/dossiers/build', outputLanguage, onStep);
};

// Generate suggested brag tags from the brag body only.
export const generateBragTags = (payload, outputLanguage, onStep) =>
  llmCall('generate-brag-tags', payload, '/api/profile/generate-brag-tags', outputLanguage, onStep);

// Extract candidate brag entries from an edited résumé Markdown. Response:
// { brags: [{title, body, impact, tags, company, entry_year, confidence}] }.
export const extractBragsFromResume = (markdown, outputLanguage, onStep) =>
  llmCall('extract-brags-from-resume', { markdown }, '/api/profile/extract-brags-from-resume', outputLanguage, onStep);

// Extract profile-overview fields from an edited résumé Markdown. Response:
// { name, headline, summary, workplace_type, skills: [{name, years?, level?}], tools: [] }.
// Extractive fields (name/workplace_type/tools) come from the résumé literally;
// headline and summary are drafts the user edits before applying.
export const extractOverviewFromResume = (markdown, outputLanguage, onStep) =>
  llmCall('extract-overview-from-resume', { markdown }, '/api/profile/extract-overview-from-resume', outputLanguage, onStep);

// Extract a full structured résumé from Markdown, ready to render into the
// house Typst template. Response is the profile.ResumeStructured shape:
// { contact, summary, education[], skills[], experience[], projects[], activities[] }.
export const extractStructuredResumeFromMd = (markdown, outputLanguage, onStep) =>
  llmCall('extract-structured-resume-from-md', { markdown }, '/api/profile/extract-structured-resume-from-md', outputLanguage, onStep);

// Ask the LLM to summarize one communication thread. Caller ships the full
// thread + entries context (the server is stateless for local-first data) and
// receives { summary }. Persisting the summary is the caller's job.
//
//   thread:  { person_name, person_notes, channel, subject, status, summary }
//   entries: [{ direction, content, occurred_at }] — newest first
export const summarizeThread = (payload, outputLanguage, onStep) =>
  llmCall('summarize-thread', payload, '/api/communications/summarize-thread', outputLanguage, onStep);

// Ask the LLM to draft outreach or a reply from a thread's context. Same
// payload shape as summarizeThread plus a `goal` of "outreach" or "reply".
// Returns { message }. The caller decides whether to save the draft.
export const generateMessage = (payload, outputLanguage, onStep) =>
  llmCall('generate-message', payload, '/api/communications/generate-message', outputLanguage, onStep);
