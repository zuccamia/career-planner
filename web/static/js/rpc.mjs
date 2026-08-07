// Thin JSON-over-HTTP client for the Go RPC surface. Endpoints are stateless
// — the browser owns persistent data locally and calls Go only for shared
// business logic (LLM prompts + sanitization).
//
// When the user has BYOK configured (see storage/byok.mjs), llmCall assembles
// the prompt via /api/llm/prompts/:name, calls the user's provider directly
// from the browser, and posts the raw response to /api/llm/parse/:name for
// sanitization — the user's API key never touches the server.
//
// LLM callers accept an optional `onStep({name, status, error?})` callback
// so the UI can show a step-list progress indicator. Status: 'running' |
// 'done' | 'failed'. Step names: scrape, discover, prompt, generate, parse.

import { isByokActive, getByokConfig } from './storage/byok.mjs';
import { isScraperConfigured } from './storage/scraper.mjs';
import { scrapeWithCache, scrapeInParallel } from './scrape-with-cache.mjs';
import { discoverATSURL } from './discover-ats.mjs';
import { callOpenAICompatible, getServerLLMStatus } from './llm-client.mjs';
import { getServerScraperStatus } from './scrape-client.mjs';
import { currentLocale, t } from './i18n.mjs';
import { isStaticHost } from './host.mjs';
import { builders, parsers } from './llm/parse/index.mjs';

const DOSSIER_SCRAPE_TTL_SECONDS = 24 * 3600;
const JD_SCRAPE_TTL_SECONDS = 3600;

// Default onStep so LLM callers can invoke the callback unconditionally
// without guarding on undefined. Pages that want progress reporting pass a
// real callback (see ui/progress.mjs).
const noopStep = () => {};

// stepped wraps an async block with running/done/failed emissions on onStep.
// The wrapped fn's result is returned on success; on failure the error is
// re-thrown after the failed emit. hintKey (optional) renders as a sub-line
// under the step label — set it when the step encompasses hidden work the
// user might otherwise not know is happening.
const stepped = async (onStep, name, fn, hintKey) => {
  onStep({ name, status: 'running', hintKey });
  try {
    const out = await fn();
    onStep({ name, status: 'done' });
    return out;
  } catch (err) {
    onStep({ name, status: 'failed', error: err && (err.message || String(err)) });
    throw err;
  }
};

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = payload?.error || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload;
};

const llmCall = async (name, input, serverPath, outputLanguage, onStep = noopStep) => {
  const lang = outputLanguage || currentLocale();
  const withLang = { ...input, output_language: lang };
  // build-dossier and extract-job-description are the two flows whose server
  // handlers may fetch web content when the caller didn't pre-scrape. When
  // the server has a scraper configured, tag the corresponding step with the
  // "includes web scraping" hint so users see why it's slower than usual.
  const mayServerScrape = name === 'build-dossier' || name === 'extract-job-description';
  const staticHost = isStaticHost();
  const serverScrapeHint = !staticHost && mayServerScrape && (await getServerScraperStatus()).available
    ? 'progress.hint.server_scrape'
    : undefined;

  const byokActive = await isByokActive();

  if (staticHost) {
    // No server to fall back to. BYOK must be configured; there's no other path.
    if (!byokActive) throw new Error(t('settings.ai.error.no_llm_configured'));
    const cfg = await getByokConfig();
    // Extra keys beyond {system, user} (enriched_raw, posting for JD) are
    // handed to parse() as the second arg, matching what /parse/:name
    // consumes on the hosted path.
    const { system, user, ...extras } = await stepped(onStep, 'prompt', () => builders[name](withLang, lang));
    const raw = await stepped(onStep, 'generate', () => callOpenAICompatible({ system, user }, cfg));
    return stepped(onStep, 'parse', () => Promise.resolve(parsers[name](raw, { input, ...extras })));
  }

  if (!byokActive) {
    // Fail fast when no server-side LLM is configured — otherwise the request
    // would 502/503 with a raw "llm client is not configured" string that
    // gives the user no path forward.
    const serverLLM = await getServerLLMStatus();
    if (!serverLLM.available) {
      throw new Error(t('settings.ai.error.no_llm_configured'));
    }
    // Server-side single round trip. Server does prompt-assembly + LLM +
    // parse internally, and — when SCRAPER_* is set — may also fetch web
    // content, all under the same "generate" step.
    return stepped(onStep, 'generate', () => post(serverPath, withLang), serverScrapeHint);
  }
  const cfg = await getByokConfig();
  // In BYOK mode the /api/llm/prompts/:name call is where the server-side
  // scrape happens (before prompt assembly). Hint the "prompt" step so the
  // user sees "includes web scraping" while it runs.
  const prompt = await stepped(onStep, 'prompt', () => post(`/api/llm/prompts/${name}`, withLang), serverScrapeHint);
  const raw = await stepped(onStep, 'generate', () => callOpenAICompatible(
    { system: prompt.system, user: prompt.user },
    cfg,
  ));
  const parseBody = { raw, input };
  if (name === 'extract-job-description') {
    parseBody.enriched_raw = prompt.enriched_raw;
    parseBody.posting = prompt.posting;
  }
  return stepped(onStep, 'parse', () => post(`/api/llm/parse/${name}`, parseBody));
};

// Ask the Go LLM pipeline to guess a canonical Company row from a typed name.
// Returns { candidate: {official_name, website, blog_url, ats_url, ats_provider, reasoning}, warning? }.
export const guessCompanyCandidate = (name, outputLanguage, onStep) =>
  llmCall('guess-candidate', { name }, '/api/companies/guess-candidate', outputLanguage, onStep);

// Extract structured facts from raw JD text. When job_description_raw is
// empty and job_posting_url is set, the source is fetched. Priority:
//   1. BYOK scraper active → scrape in the browser (any host).
//   2. Static host with no scraper → throw a user-actionable error.
//   3. Hosted with no browser scraper → defer to server; it'll route
//      known-ATS URLs to structured providers and everything else through
//      its own fetcher.
export const extractJobDescription = async (input, outputLanguage, onStep = noopStep) => {
  const enriched = { ...input };
  const url = (input.job_posting_url || '').trim();
  const rawEmpty = !(input.job_description_raw || '').trim();
  if (rawEmpty && !url) {
    throw new Error(t('applications.error.jd_input_required'));
  }
  if (rawEmpty && url) {
    if (await isScraperConfigured()) {
      const md = await scrapeWithCache(url, {
        ttlSeconds: JD_SCRAPE_TTL_SECONDS,
        stepName: 'scrape',
        onStep,
      });
      if (md) enriched.job_description_raw = md;
    } else if (isStaticHost()) {
      // No scraper on the static build — surface a "scrape: failed" step
      // so the user sees the actionable hint, then fall through and let
      // llmCall bubble up its own terminal error.
      onStep({ name: 'scrape', status: 'failed', error: t('applications.error.jd_scraper_required_static') });
    }
  }
  return llmCall('extract-job-description', enriched, '/api/applications/extract-job-description', outputLanguage, onStep);
};

// Build a dossier for the given company shape. When the browser has an
// active BYOK scraper, we scrape website + blog + ATS/careers page in
// parallel (cache-first) and — if ats_url is empty — try to discover it
// from the domain map. Scrape and discover failures are non-fatal: the
// dossier is built from whatever succeeded plus the structured fields.
//
// Missing-scraper hint fires whenever no scraper is reachable — static
// host with no BYOK key, or hosted with neither a BYOK key nor a working
// server scraper. The dossier flow has no plain-HTTP fallback (unlike
// extract-job-description), so an unreachable scraper always means a
// thinner dossier — worth surfacing even on hosted, where a broken
// self-hosted scraper would otherwise degrade silently.
export const buildDossier = async (company, outputLanguage, onStep = noopStep) => {
  const enriched = { ...company };
  const website = (company.website || '').trim();
  const blogURL = (company.blog_url || '').trim();
  const atsURL  = (company.ats_url || '').trim();

  const scraperActive = await isScraperConfigured();
  const anyURL = website || blogURL || atsURL;
  if (!scraperActive && anyURL) {
    const noServerScraper = isStaticHost() || !(await getServerScraperStatus()).available;
    if (noServerScraper) {
      onStep({ name: 'scrape', status: 'failed', error: t('dossiers.warning.scraper_recommended') });
    }
  }
  if (scraperActive) {
    // ATS discovery first (sequential) — if we discover an ATS URL here we
    // can also scrape it in the same parallel batch below. Best-effort.
    if (website && !enriched.ats_url) {
      try {
        const { atsURL, provider } = await stepped(onStep, 'discover', () => discoverATSURL(website));
        if (atsURL) {
          enriched.ats_url = atsURL;
          if (!enriched.ats_provider && provider) enriched.ats_provider = provider;
        }
      } catch (err) {
        console.warn('buildDossier: ATS discovery failed:', err);
      }
    }

    const scraped = await scrapeInParallel([
      { stepName: 'scrape_website', url: website,             key: 'website_content' },
      { stepName: 'scrape_blog',    url: blogURL,             key: 'blog_content'    },
      { stepName: 'scrape_careers', url: enriched.ats_url,    key: 'careers_content' },
    ], { ttlSeconds: DOSSIER_SCRAPE_TTL_SECONDS, onStep });
    Object.assign(enriched, scraped);
  }

  return llmCall('build-dossier', enriched, '/api/dossiers/build', outputLanguage, onStep);
};

// Generate suggested brag tags from the brag body only.
export const generateBragTags = (payload, outputLanguage, onStep) =>
  llmCall('generate-brag-tags', payload, '/api/profile/generate-brag-tags', outputLanguage, onStep);

// Extract candidate brag entries from an edited résumé Markdown. Response:
// { brags: [{title, body, impact, tags, company, entry_year, confidence}] }.
export const extractBragsFromResume = (markdown, outputLanguage, onStep) =>
  llmCall('extract-brags-from-resume', { markdown }, '/api/profile/extract-brags-from-resume', outputLanguage, onStep);

// Extract profile-overview fields from an edited résumé Markdown. Response:
// { name, headline, summary, environment, skills: [{name, years?, level?}], tools: [] }.
// Extractive fields (name/environment/tools) come from the résumé literally;
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
