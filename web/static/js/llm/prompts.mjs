// Fetches prompt JSON files from web/static/i18n/prompts/{name}.{locale}.json.
// The regression test in prompts.test.mjs guarantees a file exists for every
// (flow name, locale in manifest.json) pair, so this loader can throw on a
// miss rather than falling back silently.

import { sprintf } from './sprintf.mjs';
import { STATIC_ROOT } from '../host.mjs';

const cache = new Map();

const key = (name, locale) => `${name}.${locale}`;

// loadPrompt returns { system, user } for a flow + locale. Cached at module
// scope; a second call for the same key returns the memoized promise.
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
      return { system: body.system, user: body.user };
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
