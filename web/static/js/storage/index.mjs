// Public storage entrypoint. Module-scoped singletons + helpers for the app
// to fan out reads/writes across every connected backend.

import { LocalDiskBackend } from './local-disk.mjs';
import { GoogleDriveBackend } from './google-drive.mjs';

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
