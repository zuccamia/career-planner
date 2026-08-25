// Fetches prompt JSON files from web/static/i18n/prompts/{module}/{name}.{locale}.json.
// The prompt key is the slash-style `{module}/{name}`.
// The regression test in prompts.test.mjs guarantees a file exists for every
// (flow name, locale in manifest.json) pair, so this loader can throw on a
// miss rather than falling back silently.

import { sprintf } from './sprintf.mjs';
import { STATIC_ROOT } from '../../host.mjs';

const cache = new Map();

const key = (name, locale) => `${name}.${locale}`;

// loadPrompt returns { system, user, persona? } for a flow + locale.
// `persona` is optional — only flows whose system template has a leading
// `%s` slot carry it (tailor/ranker today). Cached at module scope.
export const loadPrompt = (name, locale) => {
  const k = key(name, locale);
  if (!cache.has(k)) {
    cache.set(k, fetch(`${STATIC_ROOT}i18n/prompts/${name}.${locale}.json`).then(async (res) => {
      if (!res.ok) {
        throw new Error(`prompt ${k}: HTTP ${res.status}`);
      }
      const body = await res.json();
      if (!body.system || !body.user) {
        throw new Error(`prompt ${k}: missing system/user`);
      }
      return {
        system: body.system,
        user: body.user,
        persona: body.persona || '',
      };
    }).catch((err) => {
      // Don't poison the cache on transient errors — clear the slot so the
      // next call retries. Prompt files are static, but the initial fetch
      // may race a slow connection.
      cache.delete(k);
      throw err;
    }));
  }
  return cache.get(k);
};

// Test-only: reset the memo between tests that stub fetch.
export const _resetPromptCacheForTests = () => cache.clear();

// buildFormatted loads a prompt by name+locale and substitutes args into the
// user template via sprintf. The building block for every flow's build().
export const buildFormatted = async (name, locale, ...args) => {
  const { system, user } = await loadPrompt(name, locale);
  return { system, user: sprintf(user, ...args) };
};

// buildFormattedWithPersona is buildFormatted for flows whose system template
// has a leading `%s` slot for a caller-provided persona string. The caller
// owns persona resolution — tailor/ranker sprintf JD.function (or a sentinel
// when empty) into the prompt's `persona` template; other flows may adopt
// the pattern by passing a static string.
export const buildFormattedWithPersona = async (name, locale, persona, ...userArgs) => {
  const loaded = await loadPrompt(name, locale);
  return {
    system: sprintf(loaded.system, persona),
    user: sprintf(loaded.user, ...userArgs),
  };
};

// Plugged into the persona template when jd.function is empty — keeps the
// sentence grammatical without inventing a scoped identity.
const PERSONA_FUNCTION_FALLBACK = 'professional';

// buildFormattedWithJDPersona resolves the JD-based persona for
// tailor/ranker-style flows in one call: reads jd.function (falling back to
// a neutral sentinel), sprintfs it into the prompt's `persona` template,
// then formats system + user like buildFormattedWithPersona.
export const buildFormattedWithJDPersona = async (name, locale, jd, ...userArgs) => {
  const loaded = await loadPrompt(name, locale);
  const persona = sprintf(loaded.persona, jd?.function || PERSONA_FUNCTION_FALLBACK);
  return {
    system: sprintf(loaded.system, persona),
    user: sprintf(loaded.user, ...userArgs),
  };
};

// buildFromField is the common case: template has one %q slot filled from
// a single trimmed input field. Throws when the field is empty so the
// caller surfaces the same error the server's HTTP 400 would. Async so
// callers always see a promise, whether the throw is preflight or in the
// underlying loadPrompt.
export const buildFromField = async (name, input, field, locale) => {
  const trimmed = (input?.[field] ?? '').trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return buildFormatted(name, locale, trimmed);
};

// ---- JSON decode ----

// Ports internal/sources/llm/client.go: extractJSON + DecodeJSONResponse.
// Strips markdown fences and slices to the outermost JSON object so the
// browser BYOK path sees the same sanitized shape the Go /parse endpoint
// produces.

export const extractJSON = (raw) => {
  let s = (raw ?? '').trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end >= start) return s.slice(start, end + 1);
  return s;
};

// decodeJSONResponse mirrors Go's DecodeJSONResponse. Throws on parse
// failure — callers surface as the same "decode JSON response" error the
// server returns.
export const decodeJSONResponse = (raw) => {
  const cleaned = extractJSON(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`decode JSON response: ${err.message}`);
  }
};

// nonNegInt coerces a raw LLM field to an integer ≥ min, or null. Guards
// against floats and negatives that bare Number() would silently accept.
export const nonNegInt = (raw, min = 0) => {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : null;
};
