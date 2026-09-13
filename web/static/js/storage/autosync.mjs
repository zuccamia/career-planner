// Debounced autosync — listens for 'local-db-mutated' events dispatched by
// db/client.mjs on every write, coalesces bursts into a single sync N seconds
// after the last edit. Skipped when divergent, when no backends are connected,
// or when the user disabled the toggle in Settings.

import { idbGet, idbSet } from './idb.mjs';
import { availableBackends } from './index.mjs';
import {
  syncCurrentSnapshot, getActiveSyncLabel, getDivergenceState,
} from './sync-current.mjs';

// Read per-schedule so tests can shrink the wait via `window.__autosyncDebounceMs`.
const DEBOUNCE_MS_DEFAULT = 5000;
const debounceMs = () => window.__autosyncDebounceMs ?? DEBOUNCE_MS_DEFAULT;
const ENABLED_KEY = 'autosyncEnabled';
const ENABLED_DEFAULT = true;

export const isAutosyncEnabled = async () => {
  const value = await idbGet(ENABLED_KEY);
  return value === undefined ? ENABLED_DEFAULT : !!value;
};

export const setAutosyncEnabled = (enabled) => idbSet(ENABLED_KEY, !!enabled);

let debounceTimer = null;
let inFlight = false;

const shouldSkip = async () => {
  if (inFlight) return true;
  if (!(await isAutosyncEnabled())) return true;
  if (availableBackends().length === 0) return true;
  if (await getDivergenceState()) return true;
  return false;
};

const runSync = async () => {
  if (await shouldSkip()) return;
  inFlight = true;
  try {
    const label = await getActiveSyncLabel();
    const result = await syncCurrentSnapshot({ label });
    // Divergence detection fires its own event; the header + banner repaint
    // via listeners in quick_sync + settings. No toast — this is background.
    if (result?.skipped) return;
  } catch (err) {
    console.warn('[autosync] sync failed:', err);
  } finally {
    inFlight = false;
  }
};

const schedule = () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; runSync(); }, debounceMs());
};

export const initAutosync = () => {
  window.addEventListener('local-db-mutated', schedule);
  // Resume flushes any pending mutation once the user resolves divergence.
  window.addEventListener('divergence-resolved', schedule);
};
