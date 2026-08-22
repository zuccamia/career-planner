// Composite tailor-resume pipeline for the browser. tailorResume dispatches
// BYOK → rank + tailor in-browser, else POST /api/applications/tailor.

import { isByokLLMActive, getByokLLMConfig } from './storage/byok-llm.mjs';
import { callOpenAICompatible } from './llm-client.mjs';
import { build as buildRank, parse as parseRank } from './llm/parse/tailor-rank-brags.mjs';
import { build as buildTailor, parse as parseTailor } from './llm/parse/tailor-draft-resume.mjs';
import { BRAG_CATEGORIES } from './entities/brag-entries.mjs';
import { stepped, noopStep } from './ui/progress.mjs';
import { fetchJSON } from './fetch-helpers.mjs';
import { t } from './i18n.mjs';

// Must match internal/applications/tailor.go.
const RANK_CHUNK_THRESHOLD = 40;
const RANK_CHUNK_SIZE = 30;
const TOP_N = 12;

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
    };
    const prompt = await buildRank(rankIn, ctx.locale);
    const raw = await callOpenAICompatible({ system: prompt.system, user: prompt.user }, cfg);
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

// tailorInBrowser runs the BYOK composite: rank all categories in parallel,
// pick top-N per category, run the tailor prompt.
const tailorInBrowser = async (input, { locale, onStep }) => {
  const cfg = await getByokLLMConfig();
  if (!cfg) throw new Error(t('settings.ai.error.no_llm_configured'));
  const buckets = groupByCategory(input.brags);
  const ctx = {
    jd_structured: input.jd_structured,
    profile: input.profile,
    base_resume_structured: input.base_resume_structured,
    role_signals: input.role_signals,
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
      experience_brags: topByCategory.experience,
      project_brags: topByCategory.project,
      activity_brags: topByCategory.activity,
    };
    const prompt = await buildTailor(tailorIn, locale);
    const raw = await callOpenAICompatible({ system: prompt.system, user: prompt.user }, cfg);
    return parseTailor(raw, { base: tailorIn.base_resume_structured });
  });
};

// tailorOnServer POSTs the unranked brags; server orchestrates rank + tailor.
const tailorOnServer = (input, { locale, onStep }) => stepped(onStep, 'server_run', () =>
  fetchJSON('/api/applications/tailor', {
    body: { ...input, output_language: locale },
    errorPrefix: 'tailor',
  }),
);

// tailorResume is the composite entry point. Input shape:
// { jd_structured, profile, base_resume_structured, role_signals, brags }
// where brags is the flat unranked list.
export const tailorResume = async (input, { locale, onStep = noopStep } = {}) =>
  (await isByokLLMActive()) ? tailorInBrowser(input, { locale, onStep }) : tailorOnServer(input, { locale, onStep });
