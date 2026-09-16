// Newest-wins sync for one file per backend (current.sqlite or <label>.sqlite).
// Switching the label targets a different file; old files stay as implicit archives.

import { exportDb, importDb } from '../db/client.mjs';
import { idbGet, idbSet, idbDel } from './idb.mjs';
import { availableBackends } from './index.mjs';
import { activeSyncFilename, syncKey, preSyncSnapshotFilename } from './config.mjs';
import { t } from '../i18n.mjs';
import { refreshCurrentSnapshotBadge } from '../ui/current_snapshot.mjs';
import { setCurrentSnapshotName } from './current-snapshot.mjs';

const LOCK = 'sync-current';

const ACTIVE_LABEL_KEY = 'activeSyncLabel';
const LOCAL_MODIFIED_KEY = 'localModifiedAt';
const LAST_SYNCED_KEY = 'lastSyncedAt';
const DIVERGENCE_KEY = 'divergenceState';

export const getActiveSyncLabel = async () => (await idbGet(ACTIVE_LABEL_KEY)) || '';
const setActiveSyncLabel = (label) => idbSet(ACTIVE_LABEL_KEY, label || '');

const getLocalModifiedAt = () => idbGet(LOCAL_MODIFIED_KEY);
export const getLastSyncedAt = () => idbGet(LAST_SYNCED_KEY);

// Called after a snapshot restore — stamps local as "aged at snapshot's mtime"
// so a fresher backend copy can still win on the next sync. Load-sample clears
// the stamp entirely so backends unconditionally beat throw-away demo state.
export const markRestoredFromSnapshot = (snapshotMtimeMs) => idbSet(LOCAL_MODIFIED_KEY, snapshotMtimeMs);
export const clearLocalModifiedAt = () => idbDel(LOCAL_MODIFIED_KEY);

// True iff local mutated since last sync — used to warn before switching label
// (a switch abandons unsynced changes because sync then targets a different file).
export const hasUnsyncedLocalChanges = async () => {
  const [modified, synced] = await Promise.all([getLocalModifiedAt(), getLastSyncedAt()]);
  if (!modified) return false;
  if (!synced) return true;
  return modified > synced;
};

// Load a snapshot from `backend` and import it. Shared between the first-sync
// seed path and Settings' explicit restore.
export const importSnapshotFromBackend = async ({ backend, snapshotId, displayName = '', mtimeMs = null }) => {
  const bytes = new Uint8Array(await backend.loadSnapshot(snapshotId));
  await importDb(bytes);
  if (displayName) await setCurrentSnapshotName(displayName);
  if (mtimeMs != null) await markRestoredFromSnapshot(mtimeMs);
  return bytes;
};

// Divergence: local edited AND some backend copy also updated, both since the
// last sync. Persisted in IDB so the pause survives reloads until resolved.
export const getDivergenceState = () => idbGet(DIVERGENCE_KEY);
const setDivergenceState = (state) => idbSet(DIVERGENCE_KEY, state);
const clearDivergenceState = () => idbDel(DIVERGENCE_KEY);

const isDivergent = (localAtMs, lastSyncedAt, newestBackendCopy) => {
  if (!lastSyncedAt) return false;
  if (!localAtMs || localAtMs <= lastSyncedAt) return false;
  if (!newestBackendCopy || +newestBackendCopy.at <= lastSyncedAt) return false;
  return true;
};

// Per-backend fan-out — returns { name, savedTo }. Caller decides whether at
// least one success is enough to proceed; divergence pause requires it so we
// never claim "backed up" when no bytes actually landed.
const savePreSyncSnapshot = async (bytes) => {
  const name = preSyncSnapshotFilename();
  const targets = availableBackends();
  const results = await Promise.allSettled(
    targets.map(b => b.writeBlob(name, new Uint8Array(bytes)))
  );
  const savedTo = results.map((r, i) => ({
    backend: targets[i].name,
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? r.reason?.message : undefined,
  }));
  return { name, savedTo };
};

// Returns {filename, winner, at, results:[{backend, action:'source'|'updated'|'error'}]},
// {skipped:'no_backends'}, or {skipped:'divergence', divergence:{...}}.
// forceWinner ∈ 'local' | 'backend' bypasses the mtime comparison and the
// divergence detection — used by resolveDivergence to execute the user's pick.
export const syncCurrentSnapshot = async ({ label = '', forceWinner = null } = {}) => {
  return navigator.locks.request(LOCK, async () => {
    const backends = availableBackends();
    if (backends.length === 0) return { skipped: 'no_backends' };

    const filename = activeSyncFilename(label);
    const key = syncKey(filename);

    const [localAtMs, lastSyncedAt, backendInfos] = await Promise.all([
      getLocalModifiedAt(),
      getLastSyncedAt(),
      Promise.all(backends.map(async (b) => ({
        backend: b,
        at: await b.statBlob(key).then(s => s?.modifiedAt || null).catch(() => null),
      }))),
    ]);
    const localAt = localAtMs ? new Date(localAtMs) : null;

    const newestBackendCopy = backendInfos
      .filter(bi => bi.at)
      .sort((a, b) => b.at - a.at)[0] || null;

    // First-sync seed: blank local + no active sync file on any backend, but
    // some backend has other snapshots (labeled files, downloaded snapshots).
    // Pick the newest across all backends and import it instead of uploading
    // a blank current.sqlite.
    let firstSyncSeed = null;
    if (!forceWinner && !localAtMs && !lastSyncedAt && !newestBackendCopy) {
      const scans = await Promise.all(backends.map(async (b) => {
        try { return { backend: b, snaps: await b.listSnapshots() }; }
        catch { return { backend: b, snaps: [] }; }
      }));
      for (const { backend, snaps } of scans) {
        for (const s of snaps) {
          const at = s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt);
          if (!firstSyncSeed || at > firstSyncSeed.at) {
            firstSyncSeed = { backend, snap: s, at };
          }
        }
      }
    }

    // If a previous run already recorded divergence, surface it as-is instead
    // of re-detecting — otherwise every retry click drops another pre-sync
    // snapshot onto the backends.
    const existing = await getDivergenceState();
    if (existing && !forceWinner) {
      return { skipped: 'divergence', divergence: existing };
    }

    // Divergence check comes before winner selection: if both sides moved since
    // last sync, pause and hand off to the user rather than silently overwrite.
    if (!forceWinner && isDivergent(localAtMs, lastSyncedAt, newestBackendCopy)) {
      const localBytes = (await exportDb()).bytes;
      const { name: preSyncName, savedTo } = await savePreSyncSnapshot(localBytes);
      // If no backend accepted the safety-net write, don't pause — the banner
      // would falsely claim a backup exists. Bubble up as a sync error.
      if (!savedTo.some(s => s.ok)) {
        const errs = savedTo.map(s => `${s.backend}: ${s.error || 'unknown'}`).join('; ');
        throw new Error(`pre-sync backup failed on every backend: ${errs}`);
      }
      const divergence = {
        detectedAt: Date.now(),
        localAtMs,
        backendMtime: +newestBackendCopy.at,
        backendName: newestBackendCopy.backend.name,
        filename,
        label,
        preSyncSnapshotName: preSyncName,
        preSyncSavedTo: savedTo,
      };
      await setDivergenceState(divergence);
      window.dispatchEvent(new CustomEvent('divergence-detected'));
      return { skipped: 'divergence', divergence };
    }

    // Winner selection. Ties favor local; forceWinner overrides for
    // user-resolved divergence. Seed only fires on a provably blank first sync.
    const backendWinner = () => ({ source: 'backend', backend: newestBackendCopy.backend, at: newestBackendCopy.at });
    let winner;
    if (forceWinner === 'local') {
      winner = { source: 'local', at: new Date() };
    } else if (forceWinner === 'backend' && newestBackendCopy) {
      winner = backendWinner();
    } else if (localAt && (!newestBackendCopy || localAt >= newestBackendCopy.at)) {
      winner = { source: 'local', at: localAt };
    } else if (newestBackendCopy) {
      winner = backendWinner();
    } else if (firstSyncSeed) {
      winner = { source: 'seed', backend: firstSyncSeed.backend, at: firstSyncSeed.at, snap: firstSyncSeed.snap };
    } else {
      winner = { source: 'local', at: new Date() };
    }

    let bytes;
    if (winner.source === 'local') {
      bytes = (await exportDb()).bytes;
    } else if (winner.source === 'seed') {
      bytes = await importSnapshotFromBackend({
        backend: winner.backend,
        snapshotId: winner.snap.id,
        displayName: winner.snap.name,
      });
    } else {
      bytes = new Uint8Array(await winner.backend.readBlob(key));
      try {
        await importDb(bytes);
      } catch (err) {
        // Backend copy is unreadable (e.g. corrupted by an earlier fan-out bug).
        // Fall back to local-wins so the write loop overwrites the bad blob
        // with a valid one — otherwise the device is permanently stuck.
        console.warn('[sync] backend import failed, falling back to local-wins:', err.message);
        winner = { source: 'local', at: new Date() };
        bytes = (await exportDb()).bytes;
      }
    }

    const results = [];
    for (const bi of backendInfos) {
      if (winner.source === 'backend' && bi.backend === winner.backend) {
        results.push({ backend: bi.backend.name, action: 'source' });
        continue;
      }
      try {
        const meta = await bi.backend.writeBlob(key, bytes);
        results.push({ backend: bi.backend.name, action: 'updated', at: meta.modifiedAt });
      } catch (err) {
        results.push({ backend: bi.backend.name, action: 'error', error: err.message });
      }
    }

    await setActiveSyncLabel(label);
    // Skip the LOCAL_MODIFIED write when local won with an unchanged timestamp.
    if (winner.source !== 'local' || +winner.at !== localAtMs) {
      await idbSet(LOCAL_MODIFIED_KEY, +winner.at);
    }
    await idbSet(LAST_SYNCED_KEY, Date.now());

    return {
      filename,
      winner: winner.source === 'local' ? 'local' : winner.backend.name,
      at: winner.at,
      results,
      seededFrom: winner.source === 'seed' ? winner.snap.name : undefined,
    };
  });
};

// User picks a side on the divergence banner. Clears state and forces a sync
// in the chosen direction.
export const resolveDivergence = async (choice /* 'local' | 'backend' */) => {
  const state = await getDivergenceState();
  if (!state) return { skipped: 'no_divergence' };
  await clearDivergenceState();
  window.dispatchEvent(new CustomEvent('divergence-resolved'));
  return syncCurrentSnapshot({ label: state.label, forceWinner: choice });
};

// Shared post-sync UX: refresh badge, reload if a backend replaced local,
// return a summary the caller turns into its own toast.
export const finalizeSyncResult = (result) => {
  refreshCurrentSnapshotBadge();
  const errors = result.results.filter(r => r.action === 'error');
  const updated = result.results.filter(r => r.action === 'updated').map(r => r.backend);
  const winner = result.winner === 'local' ? t('settings.sync.winner.local') : result.winner;
  if (result.winner !== 'local') setTimeout(() => location.reload(), 500);
  return { winner, errors, updated };
};
