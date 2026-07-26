// Thin JSON-over-HTTP client for the Go RPC surface.
// Endpoints are stateless — the browser owns all persistent data locally and
// only calls Go for shared business logic (LLM prompts + sanitization).

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

// Ask the Go LLM pipeline to guess a canonical Company row from a typed name.
// Returns { candidate: {official_name, website, tech_blog_url, ats_url, ats_provider, reasoning}, warning? }.
export const guessCompanyCandidate = (name) =>
  post('/api/companies/guess-candidate', { name });

// Extract structured facts from raw JD text. When input.job_description_raw is
// empty and job_posting_url is set, the server fetches the posting and returns
// the fetched text alongside the structured result:
//   { structured: JobDescriptionStructured, job_description_raw: string }
export const extractJobDescription = (input) =>
  post('/api/applications/extract-job-description', input);

// Build a dossier for the given company shape. Returns the Dossier struct
// (id/company_id/timestamps are zero — the caller assigns them locally).
export const buildDossier = (company) =>
  post('/api/dossiers/build', company);

// Ask the LLM to summarize one communication thread. Caller ships the full
// thread + entries context (the server is stateless for local-first data) and
// receives { summary }. Persisting the summary is the caller's job.
//
//   thread:  { person_name, person_notes, channel, subject, status, summary }
//   entries: [{ direction, content, occurred_at }] — newest first
export const summarizeThread = (payload) =>
  post('/api/communications/summarize-thread', payload);

// Ask the LLM to draft outreach or a reply from a thread's context. Same
// payload shape as summarizeThread plus a `goal` of "outreach" or "reply".
// Returns { message }. The caller decides whether to save the draft.
export const generateMessage = (payload) =>
  post('/api/communications/generate-message', payload);
