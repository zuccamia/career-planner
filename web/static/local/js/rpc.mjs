// Thin JSON-over-HTTP client for the Go RPC surface.
// Endpoints are stateless — the browser owns all persistent data locally and
// only calls Go for shared business logic (LLM prompts + sanitization).
//
// LLM calls route through BYOK when the user has configured a personal key
// (see storage/byok.mjs). In BYOK mode we:
//   1. POST the input to /api/llm/prompts/:name → get {system, user, ...}.
//   2. Call the user's provider directly from the browser (llm-client.mjs).
//   3. POST the raw response to /api/llm/parse/:name → get the same shape
//      the server-side endpoint would return.
// The user's API key never leaves the browser. The server-side path is
// unchanged — llmCall falls through to the single-round-trip endpoint when
// BYOK is off.

import { isByokActive, getByokConfig } from './storage/byok.mjs';
import { callOpenAICompatible, getServerLLMStatus } from './llm-client.mjs';

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

// llmCall dispatches an LLM-touching request through BYOK when enabled,
// otherwise through the single server-side endpoint.
//   name          — endpoint slug shared by server-side + BYOK paths
//                   (guess-candidate / extract-job-description / …).
//   input         — the JSON body the server-side endpoint expects.
//   serverPath    — the full server-side endpoint URL (each has its own
//                   vanity path).
// Returns whatever the server-side endpoint would return.
const llmCall = async (name, input, serverPath) => {
  if (!(await isByokActive())) {
    // Fail fast when no server-side LLM is configured — otherwise the request
    // would 502/503 with a raw "llm client is not configured" string that
    // gives the user no path forward.
    const serverLLM = await getServerLLMStatus();
    if (!serverLLM.available) {
      throw new Error('This server has no LLM key configured. Open Settings → AI provider and add your own key to use AI features.');
    }
    return post(serverPath, input);
  }
  const cfg = await getByokConfig();
  // 1. Ask the server to assemble the prompt (plus any pass-through context
  //    like enriched_raw + posting for JD extraction).
  const prompt = await post(`/api/llm/prompts/${name}`, input);
  // 2. Call the user's provider directly.
  const raw = await callOpenAICompatible(
    { system: prompt.system, user: prompt.user },
    cfg,
  );
  // 3. Send the raw response back for sanitization. For JD extraction we
  //    also echo the pass-through context so the server doesn't refetch the
  //    posting URL.
  const parseBody = { raw, input };
  if (name === 'extract-job-description') {
    parseBody.enriched_raw = prompt.enriched_raw;
    parseBody.posting = prompt.posting;
  }
  return post(`/api/llm/parse/${name}`, parseBody);
};

// Ask the Go LLM pipeline to guess a canonical Company row from a typed name.
// Returns { candidate: {official_name, website, tech_blog_url, ats_url, ats_provider, reasoning}, warning? }.
export const guessCompanyCandidate = (name) =>
  llmCall('guess-candidate', { name }, '/api/companies/guess-candidate');

// Extract structured facts from raw JD text. When input.job_description_raw is
// empty and job_posting_url is set, the server fetches the posting and returns
// the fetched text alongside the structured result:
//   { structured: JobDescriptionStructured, job_description_raw: string }
export const extractJobDescription = (input) =>
  llmCall('extract-job-description', input, '/api/applications/extract-job-description');

// Build a dossier for the given company shape. Returns the Dossier struct;
// the caller writes it onto the companies row via updateCompanyDossier.
export const buildDossier = (company) =>
  llmCall('build-dossier', company, '/api/dossiers/build');

// Generate suggested brag tags from the brag body only.
export const generateBragTags = (payload) =>
  llmCall('generate-brag-tags', payload, '/api/profile/generate-brag-tags');

// Ask the LLM to summarize one communication thread. Caller ships the full
// thread + entries context (the server is stateless for local-first data) and
// receives { summary }. Persisting the summary is the caller's job.
//
//   thread:  { person_name, person_notes, channel, subject, status, summary }
//   entries: [{ direction, content, occurred_at }] — newest first
export const summarizeThread = (payload) =>
  llmCall('summarize-thread', payload, '/api/communications/summarize-thread');

// Ask the LLM to draft outreach or a reply from a thread's context. Same
// payload shape as summarizeThread plus a `goal` of "outreach" or "reply".
// Returns { message }. The caller decides whether to save the draft.
export const generateMessage = (payload) =>
  llmCall('generate-message', payload, '/api/communications/generate-message');
