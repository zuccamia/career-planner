// Composite tailor-resume pipeline. Dispatch order (see tailorResume): BYOK
// tool loop → server tool loop → bundled server endpoint. Each tool-loop
// path falls back to rank+draft on tool-support failures.

import { isByokLLMActive, getByokLLMConfig } from '../../storage/byok-llm.mjs';
import { callOpenAICompatible, getServerLLMStatus } from '../../sources/llm/client.mjs';
import { build as buildRank, parse as parseRank } from '../../prompt-handlers/applications/tailor-rank-brags.mjs';
import { build as buildTailor, parse as parseTailor } from '../../prompt-handlers/applications/tailor-draft-resume.mjs';
import { build as buildTools, parse as parseTools } from '../../prompt-handlers/applications/tailor-with-tools.mjs';
import { BRAG_CATEGORIES, searchBrags, searchResumes, listBragEntriesByIds } from '../../entities/profile.mjs';
import { stepped, noopStep } from '../../ui/progress.mjs';
import { fetchJSON } from '../../http.mjs';
import { t } from '../../i18n.mjs';

// Must match internal/applications/tailor.go.
const RANK_CHUNK_THRESHOLD = 40;
const RANK_CHUNK_SIZE = 30;
const TOP_N = 12;
const MAX_TOOL_ITERATIONS = 6;

const bragForPrompt = (row) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  impact: row.impact,
  tags: row.tags || [],
  company_name: row.company_name || '',
  entry_year: row.entry_year || 0,
  category: row.category || 'experience',
});

const resumeForPrompt = (row) => ({
  id: row.id,
  title: row.title,
  format: row.format,
  body: row.body,
});

// groupByCategory bucketises brags; unknown categories → experience.
const groupByCategory = (brags) => {
  const out = Object.fromEntries(BRAG_CATEGORIES.map((c) => [c, []]));
  for (const b of brags) {
    const cat = BRAG_CATEGORIES.includes(b.category) ? b.category : 'experience';
    out[cat].push(b);
  }
  return out;
};

// rankBucketChunked ranks one bucket via BYOK LLM, chunking above threshold.
const rankBucketChunked = async (bucket, ctx, cfg) => {
  if (bucket.length === 0) return [];
  const rankOne = async (batch) => {
    const rankIn = {
      jd_structured: ctx.jd_structured,
      profile: ctx.profile,
      base_resume_structured: ctx.base_resume_structured,
      brags: batch.map(bragForPrompt),
      role_signals: ctx.role_signals,
      profile_fit: ctx.profile_fit,
    };
    const prompt = await buildRank(rankIn, ctx.locale);
    const { content: raw } = await callOpenAICompatible({ system: prompt.system, user: prompt.user }, cfg);
    return parseRank(raw, { input: rankIn }).ranked;
  };
  if (bucket.length <= RANK_CHUNK_THRESHOLD) return rankOne(bucket);
  const chunks = [];
  for (let i = 0; i < bucket.length; i += RANK_CHUNK_SIZE) chunks.push(bucket.slice(i, i + RANK_CHUNK_SIZE));
  const merged = (await Promise.all(chunks.map(rankOne))).flat();
  merged.sort((a, b) => Math.max(b.swap_priority, b.relevance) - Math.max(a.swap_priority, a.relevance));
  return merged;
};

// selectTopNBrags maps top-N ranked rows back to full brags (best first).
const selectTopNBrags = (ranked, bucket, n) => {
  const byId = new Map(bucket.map((b) => [b.id, b]));
  const out = [];
  for (const row of ranked) {
    const b = byId.get(row.brag_id);
    if (!b) continue;
    out.push(b);
    if (out.length >= n) break;
  }
  return out;
};

// Fallback: rank all brags per category, keep top-N, hand to the draft prompt.
const tailorInBrowserRankAndDraft = async (input, { locale, onStep }, cfg) => {
  const buckets = groupByCategory(input.brags || []);
  const ctx = {
    jd_structured: input.jd_structured,
    profile: input.profile,
    base_resume_structured: input.base_resume_structured,
    role_signals: input.role_signals,
    profile_fit: input.profile_fit || '',
    locale,
  };
  const rankedByCategory = await stepped(onStep, 'rank_brags', async () => {
    const entries = await Promise.all(
      BRAG_CATEGORIES.map(async (cat) => [cat, await rankBucketChunked(buckets[cat], ctx, cfg)]),
    );
    return Object.fromEntries(entries);
  });
  const topByCategory = Object.fromEntries(
    BRAG_CATEGORIES.map((cat) => [
      cat, selectTopNBrags(rankedByCategory[cat], buckets[cat], TOP_N).map(bragForPrompt),
    ]),
  );
  return stepped(onStep, 'draft_resume', async () => {
    const tailorIn = {
      jd_structured: input.jd_structured,
      profile: input.profile,
      base_resume_structured: input.base_resume_structured,
      role_signals: input.role_signals,
      profile_fit: input.profile_fit || '',
      experience_brags: topByCategory.experience,
      project_brags: topByCategory.project,
      activity_brags: topByCategory.activity,
    };
    const prompt = await buildTailor(tailorIn, locale);
    const { content: raw } = await callOpenAICompatible({ system: prompt.system, user: prompt.user }, cfg);
    return parseTailor(raw, { base: tailorIn.base_resume_structured });
  });
};

// Runs one tool call locally. Errors surface as `{ error }` so the model
// can retry with a different query instead of aborting the loop.
const dispatchToolCall = async ({ name, arguments: argsJson }) => {
  let args = {};
  try { args = argsJson ? JSON.parse(argsJson) : {}; }
  catch (err) { return { error: `invalid arguments JSON: ${err.message}` }; }
  try {
    if (name === 'get_brags') {
      const rows = await listBragEntriesByIds(args.ids);
      return { results: rows.map(bragForPrompt) };
    }
    if (name === 'search_brags') {
      const rows = await searchBrags({ query: args.query, category: args.category ?? null, limit: args.limit });
      return { results: rows.map(bragForPrompt) };
    }
    if (name === 'search_resumes') {
      const rows = await searchResumes({ query: args.query, limit: args.limit });
      return { results: rows.map(resumeForPrompt) };
    }
    return { error: `unknown tool: ${name}` };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
};

// Category suffix keeps parallel search_brags calls in one turn from
// colliding on a shared progress-row key.
const toolStepName = (call) => {
  if (call.name === 'get_brags') return 'tool_get_brags';
  if (call.name === 'search_resumes') return 'tool_search_resumes';
  let scope = 'all';
  try {
    const args = call.arguments ? JSON.parse(call.arguments) : {};
    if (typeof args.category === 'string' && args.category) scope = args.category;
  } catch { /* keep default scope */ }
  return `tool_search_brags_${scope}`;
};

// BYOK-side tool loop: browser owns prompt assembly, LLM call, and parsing.
// Throws { code: 'tool_loop_failed' } on cap-hit.
const runBYOKToolLoop = async (input, { locale, onStep }, cfg) => {
  const promptInput = {
    jd_structured: input.jd_structured,
    profile: input.profile,
    base_resume_structured: input.base_resume_structured,
    role_signals: input.role_signals,
    profile_fit: input.profile_fit || '',
  };
  const { system, user, tools } = await buildTools(promptInput, locale);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const toolCounts = {};
  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const { content, toolCalls } = await callOpenAICompatible({ messages, tools }, cfg);
    if (toolCalls.length) {
      messages.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const call of toolCalls) {
        toolCounts[call.name] = (toolCounts[call.name] || 0) + 1;
        const result = await stepped(onStep, toolStepName(call), () => dispatchToolCall(call));
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }
    if (content) {
      console.log('[tailor] byok tool loop:', { turns: iter + 1, tools: toolCounts });
      return stepped(onStep, 'tool_final_draft',
        async () => parseTools(content, { base: input.base_resume_structured }));
    }
    break;
  }
  console.warn('[tailor] byok tool loop exhausted without final draft:', { turns: MAX_TOOL_ITERATIONS, tools: toolCounts });
  throw Object.assign(new Error('tool loop did not produce a parseable draft'), {
    code: 'tool_loop_failed',
  });
};

// Translates a tool-support error from the server (message matches
// llm.APIError.IsToolSupportError) into a distinct code the caller falls
// back on.
const postTailorTurn = async ({ input, exchanges }) => {
  let res;
  try {
    res = await fetch('/api/applications/tailor/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, exchanges }),
    });
  } catch (err) {
    throw Object.assign(new Error(`Network error reaching server: ${err.message}`), { code: 'network' });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (/not supported by this provider|tool_use is not supported|invalid parameter: tools|unknown field: tools|does not support tools/i.test(text)) {
      throw Object.assign(new Error(text || 'server LLM does not support tools'), {
        code: 'tools_unsupported', status: res.status,
      });
    }
    throw Object.assign(new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`), {
      code: 'provider', status: res.status,
    });
  }
  return res.json();
};

// Server-side tool loop: server assembles the prompt and parses the final
// draft; browser only iterates turns and executes tool calls locally.
const runServerToolLoop = async (input, { locale, onStep }) => {
  const turnInput = {
    jd_structured: input.jd_structured,
    profile: input.profile,
    base_resume_structured: input.base_resume_structured,
    role_signals: input.role_signals,
    profile_fit: input.profile_fit || '',
    output_language: locale,
  };
  // Per-turn logging is server-side (log.Printf("tailor-turn …")).
  const exchanges = [];
  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const resp = await postTailorTurn({ input: turnInput, exchanges });
    if (resp.result) {
      return stepped(onStep, 'tool_final_draft', async () => resp.result);
    }
    const calls = resp.tool_calls || [];
    if (!calls.length) break;
    const normalized = calls.map((c) => ({
      id: c.id || '',
      name: c.function?.name || '',
      arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : '',
    }));
    const results = await Promise.all(normalized.map((call) =>
      stepped(onStep, toolStepName(call), async () => ({
        id: call.id,
        result_json: JSON.stringify(await dispatchToolCall(call)),
      })),
    ));
    exchanges.push({
      tool_calls: calls,
      tool_results: results.map((r) => ({ id: r.id, result_json: JSON.parse(r.result_json) })),
    });
  }
  throw Object.assign(new Error('tool loop did not produce a parseable draft'), {
    code: 'tool_loop_failed',
  });
};

// Errors that trigger fallback from the tool-loop path to a bundled pipeline.
const FALLBACK_CODES = new Set(['tools_unsupported', 'tool_loop_failed', 'shape']);
const isFallbackError = (err) =>
  FALLBACK_CODES.has(err?.code) || err?.message?.startsWith('decode JSON response');

const emitFallbackStep = (onStep, err) => {
  console.warn('[tailor] tool path failed, falling back:', err?.code || 'unknown', err?.message);
  onStep({ name: 'tool_path_fallback', status: 'running', hintKey: 'progress.hint.tool_fallback' });
  onStep({ name: 'tool_path_fallback', status: 'done' });
};

// BYOK entry: tool loop against the user's provider, fallback to rank+draft.
// Auth/network errors re-raise (surface to the user).
const tailorInBrowser = async (input, { locale, onStep }) => {
  const cfg = await getByokLLMConfig();
  if (!cfg) throw new Error(t('settings.ai.error.no_llm_configured'));
  try {
    return await runBYOKToolLoop(input, { locale, onStep }, cfg);
  } catch (err) {
    if (!isFallbackError(err)) throw err;
    emitFallbackStep(onStep, err);
    return tailorInBrowserRankAndDraft(input, { locale, onStep }, cfg);
  }
};

// One-shot server pipeline: rank + draft happen server-side, no tool loop.
const tailorOnServerBundled = (input, { locale, onStep }) => stepped(onStep, 'server_run',
  () => fetchJSON('/api/applications/tailor', {
    body: { ...input, output_language: locale },
    errorPrefix: 'tailor',
  }),
);

// Server entry: server LLM drives the tool loop via /tailor/turn, fallback
// to the bundled server pipeline.
const tailorOnServer = async (input, { locale, onStep }) => {
  try {
    return await runServerToolLoop(input, { locale, onStep });
  } catch (err) {
    if (!isFallbackError(err)) throw err;
    emitFallbackStep(onStep, err);
    return tailorOnServerBundled(input, { locale, onStep });
  }
};

// Entry point. Input: { jd_structured, profile, base_resume_structured,
// role_signals, profile_fit?, brags }. profile_fit seeds the tool-loop
// path; brags is only consumed by the rank+draft fallback.
export const tailorResume = async (input, { locale, onStep = noopStep } = {}) => {
  if (await isByokLLMActive()) return tailorInBrowser(input, { locale, onStep });
  const serverLLM = await getServerLLMStatus();
  if (serverLLM?.available) return tailorOnServer(input, { locale, onStep });
  return tailorOnServerBundled(input, { locale, onStep });
};
