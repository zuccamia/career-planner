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
import { isScraperActive } from './storage/scraper.mjs';
import { scrapeWithCache, scrapeInParallel } from './scrape-with-cache.mjs';
import { discoverATSURL } from './discover-ats.mjs';
import { callOpenAICompatible, getServerLLMStatus } from './llm-client.mjs';
import { getServerScraperStatus } from './scrape-client.mjs';
import { currentLocale, t } from './i18n.mjs';

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
  const serverScrapeHint = mayServerScrape && (await getServerScraperStatus()).available
    ? 'progress.hint.server_scrape'
    : undefined;
  if (!(await isByokActive())) {
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

// Known ATS host patterns. When a posting URL matches, we let the server's
// Greenhouse/Lever/Ashby providers extract structured fields the raw markdown
// would lose; otherwise the browser BYOK scraper handles it if active.
const KNOWN_ATS_HOSTS = [
  /^(job-)?boards\.greenhouse\.io$|\.greenhouse\.io$/i,
  /^jobs\.lever\.co$/i,
  /\.ashbyhq\.com$|^jobs\.ashbyhq\.com$/i,
];

const isKnownATSHost = (rawURL) => {
  try {
    const host = new URL(rawURL).hostname;
    return KNOWN_ATS_HOSTS.some(rx => rx.test(host));
  } catch { return false; }
};

// Extract structured facts from raw JD text. When job_description_raw is
// empty and job_posting_url is set, the source is fetched — client-side via
// the BYOK scraper for unknown ATS hosts, otherwise server-side.
export const extractJobDescription = async (input, outputLanguage, onStep = noopStep) => {
  const enriched = { ...input };
  const url = (input.job_posting_url || '').trim();
  const rawEmpty = !(input.job_description_raw || '').trim();
  if (rawEmpty && url && !isKnownATSHost(url) && (await isScraperActive())) {
    // Non-fatal — if the browser scrape fails we still let the server try.
    try {
      const md = await scrapeWithCache(url, {
        ttlSeconds: JD_SCRAPE_TTL_SECONDS,
        stepName: 'scrape',
        onStep,
      });
      if (md) enriched.job_description_raw = md;
    } catch (err) {
      console.warn('extractJobDescription: browser scrape failed, letting server try:', err);
    }
  }
  return llmCall('extract-job-description', enriched, '/api/applications/extract-job-description', outputLanguage, onStep);
};

// Build a dossier for the given company shape. When the browser has an
// active BYOK scraper, we scrape website + blog + ATS/careers page in
// parallel (cache-first) and — if ats_url is empty — try to discover it
// from the domain map. Scrape and discover failures are non-fatal: the
// dossier is built from whatever succeeded plus the structured fields.
export const buildDossier = async (company, outputLanguage, onStep = noopStep) => {
  const enriched = { ...company };
  const website = (company.website || '').trim();
  const blogURL = (company.blog_url || '').trim();

  if (await isScraperActive()) {
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
