// BYOK (bring-your-own-key) LLM config. Stored in the same IndexedDB the
// storage backends use for Drive tokens and snapshot metadata — one origin,
// one storage boundary.
//
// The key never leaves this browser: rpc.mjs reads the config, assembles the
// prompt via /api/llm/prompts/:name, calls the user's OpenAI-compatible
// provider directly, then posts the raw response to /api/llm/parse/:name.
// The server sees prompts + raw responses but never the key.
//
// The record is deleted by:
//   - Settings → "Clear key"                        (clearByokLLMConfig)
//   - Google Drive sign-out, if clearOnSignOut=true (settings.mjs)
//   - Settings → "Wipe all local data"              (idbWipe drops the DB)

import { idbGet, idbSet, idbDel } from './idb.mjs';

const KEY = 'byokConfig';

// Defaults surfaced in the Settings form when no config has been saved yet.
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';

// getByokLLMConfig returns the saved config, or null if BYOK has never been
// enabled on this browser. Shape: { enabled, baseUrl, apiKey, model,
// clearOnSignOut, updatedAt }. Callers should treat null as "use server-side LLM".
export const getByokLLMConfig = async () => {
  const raw = await idbGet(KEY);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
};

// isByokLLMActive is a convenience: true when a config exists AND is enabled
// AND has the fields needed to make a provider call.
export const isByokLLMActive = async () => {
  const cfg = await getByokLLMConfig();
  return !!(cfg && cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
};

// saveByokLLMConfig persists a validated config. The caller is responsible for
// running testConnection first — this function only stores.
export const saveByokLLMConfig = async (cfg) => {
  const normalized = {
    enabled: !!cfg.enabled,
    baseUrl: String(cfg.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(cfg.apiKey || '').trim(),
    model: String(cfg.model || '').trim(),
    clearOnSignOut: !!cfg.clearOnSignOut,
    updatedAt: new Date().toISOString(),
  };
  await idbSet(KEY, normalized);
  return normalized;
};

// clearByokLLMConfig removes the saved config entirely. Used by the Settings
// "Clear key" button and (when clearOnSignOut is true) by the Drive signout
// path in settings.mjs.
export const clearByokLLMConfig = () => idbDel(KEY);
