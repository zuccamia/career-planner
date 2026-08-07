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
//   - Settings → "Clear key"                        (clearByokConfig)
//   - Google Drive sign-out, if clearOnSignOut=true (settings.mjs)
//   - Settings → "Wipe all local data"              (idbWipe drops the DB)

import { idbGet, idbSet, idbDel } from './idb.mjs';

const KEY = 'byokConfig';

// getByokConfig returns the saved config, or null if BYOK has never been
// enabled on this browser. Shape: { enabled, baseUrl, apiKey, model,
// clearOnSignOut, updatedAt }. Callers should treat null as "use server-side LLM".
export const getByokConfig = async () => {
  const raw = await idbGet(KEY);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
};

// isByokActive is a convenience: true when a config exists AND is enabled
// AND has the fields needed to make a provider call.
export const isByokActive = async () => {
  const cfg = await getByokConfig();
  return !!(cfg && cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
};

// saveByokConfig persists a validated config. The caller is responsible for
// running testConnection first — this function only stores.
export const saveByokConfig = async (cfg) => {
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

// clearByokConfig removes the saved config entirely. Used by the Settings
// "Clear key" button and (when clearOnSignOut is true) by the Drive signout
// path in settings.mjs.
export const clearByokConfig = () => idbDel(KEY);
