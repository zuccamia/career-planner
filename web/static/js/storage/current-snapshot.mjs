// Tracks the "current" snapshot — the filename of the snapshot the browser DB
// was last restored from, or the last labeled snapshot saved from this DB.
// Purely informational: shown in the sidebar so the user can tell which
// point-in-time they're looking at (e.g. `spring-2026` vs `fall-2020`).
//
// Not a durability mechanism and not tied to a dirty flag — after arbitrary
// edits the badge still shows the last-known restore/save name. That's the
// intended UX for now; a "modified" indicator can layer on later.

import { idbGet, idbSet, idbDel } from './idb.mjs';
import { SNAPSHOT_PREFIX, SNAPSHOT_SUFFIX, SNAPSHOT_LABEL_SEP } from './config.mjs';

const KEY = 'currentSnapshotName';

export const getCurrentSnapshotName = () => idbGet(KEY);
export const setCurrentSnapshotName = (name) => idbSet(KEY, name);
export const clearCurrentSnapshotName = () => idbDel(KEY);

// Human-readable form for the sidebar badge:
//   snapshot-20260725-133045.sqlite               → "2026-07-25 13:30"
//   snapshot-20260725-133045__spring-2026.sqlite  → "spring-2026 · 2026-07-25"
export const formatSnapshotName = (name) => {
  if (!name) return '';
  const base = name.startsWith(SNAPSHOT_PREFIX) ? name.slice(SNAPSHOT_PREFIX.length) : name;
  const stem = base.endsWith(SNAPSHOT_SUFFIX) ? base.slice(0, -SNAPSHOT_SUFFIX.length) : base;
  const sep = stem.indexOf(SNAPSHOT_LABEL_SEP);
  const stamp = sep === -1 ? stem : stem.slice(0, sep);
  const label = sep === -1 ? '' : stem.slice(sep + SNAPSHOT_LABEL_SEP.length);

  // stamp = YYYYMMDD-HHMMSS
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : stamp;
  const time = m ? `${m[4]}:${m[5]}` : '';
  if (label) return `${label} · ${date}`;
  return time ? `${date} ${time}` : date;
};
