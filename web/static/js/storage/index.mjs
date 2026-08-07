// Public storage entrypoint. Module-scoped singletons + helpers for the app
// to fan out reads/writes across every connected backend.

import { LocalDiskBackend } from './local-disk.mjs';
import { GoogleDriveBackend } from './google-drive.mjs';
import { isLabeledSnapshot } from './config.mjs';

export const localDisk = new LocalDiskBackend();
export const googleDrive = new GoogleDriveBackend();
export const backends = [localDisk, googleDrive];

export const connectedBackends = () => backends.filter(b => b.isReady());
export const availableBackends = () => backends.filter(b => b.isAvailable());

// Attempt to restore any persisted connections without prompting the user.
// Returns a map of backend name -> restore result, useful for status UI.
export const restoreAll = async () => {
  const out = {};
  for (const b of backends) {
    try { out[b.name] = await b.tryRestore(); }
    catch (err) { out[b.name] = false; console.error(`[storage] restore ${b.name} failed`, err); }
  }
  return out;
};

// Keep only the K most-recent AUTO snapshots on the given backend.
// Labeled snapshots (filename contains the label separator) are exempt from
// retention pruning — they represent user-picked checkpoints and stay forever
// until explicitly deleted.
export const pruneBackend = async (backend, keep) => {
  const list = await backend.listSnapshots();
  const auto = list.filter(s => !isLabeledSnapshot(s.name || s.id));
  auto.sort((a, b) => b.createdAt - a.createdAt);
  const toDelete = auto.slice(keep);
  const errors = [];
  for (const s of toDelete) {
    try { await backend.deleteSnapshot(s.id); }
    catch (err) { errors.push({ id: s.id, error: err.message }); }
  }
  return { deleted: toDelete.length - errors.length, errors };
};

// Save `bytes` to every available backend, then prune each to `keep`.
// Each backend receives its own Uint8Array copy since some consumers (Drive
// multipart Blob) may retain the buffer.
export const snapshotAllBackends = async (bytes, { keep = 5, label = '' } = {}) => {
  const active = availableBackends();
  const results = [];
  for (const b of active) {
    try {
      const copy = new Uint8Array(bytes);
      const meta = await b.saveSnapshot(copy, { label });
      const prune = await pruneBackend(b, keep);
      results.push({ backend: b.name, ok: true, meta, prune });
    } catch (err) {
      results.push({ backend: b.name, ok: false, error: err.message });
    }
  }
  return results;
};
