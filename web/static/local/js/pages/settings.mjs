// Settings page: manage the two storage backends (local disk, Google Drive)
// and take manual snapshots. Auto-snapshot config lands in a later phase.
// Styling mirrors the legacy Go app (rounded-2xl cards, blue-600 buttons,
// blue-700 eyebrows).

import { exportDb, importDb, wipeDb, disposeWorker } from '../db/client.mjs';
import {
  localDisk, googleDrive,
  availableBackends, snapshotAllBackends,
} from '../storage/index.mjs';
import { LocalDiskBackend } from '../storage/local-disk.mjs';
import { snapshotFilename, sanitizeSnapshotLabel } from '../storage/config.mjs';
import {
  setCurrentSnapshotName, clearCurrentSnapshotName,
} from '../storage/current-snapshot.mjs';
import { refreshCurrentSnapshotBadge } from '../ui/current_snapshot.mjs';
import { idbWipe } from '../storage/idb.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { button, badge, inlineError, setInlineError } from '../ui/components.mjs';

const kb = (n) => `${(n/1024).toFixed(1)} KB`;

const STATUS_CLASS = 'text-sm font-medium';

// ---------- markup ----------
const render = (root) => {
  root.innerHTML = `
    <div class="space-y-6">
      <div id="toast" class="hidden"></div>

      <section class="space-y-2">
        <p class="${CLS.eyebrow}">Settings</p>
        <p class="text-sm text-slate-500">
          Your data lives in this browser. Connect one or more backends below so snapshots
          survive if the browser clears its storage.
        </p>
      </section>

      <section class="${CLS.card}">
        <header class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <p class="${CLS.eyebrow}">Local disk</p>
              <span id="disk-status"></span>
            </div>
            <p class="text-sm text-slate-500" id="local-disk-support"></p>
          </div>
          <div class="flex flex-wrap gap-2">
            ${button({ id: 'btn-connect-disk', variant: 'successIcon', icon: 'link', iconOnly: true, ariaLabel: 'Connect folder', disabled: true })}
            ${button({ id: 'btn-forget-disk', variant: 'dangerIcon', icon: 'linkSlash', iconOnly: true, ariaLabel: 'Forget folder', disabled: true })}
            ${button({ id: 'btn-list-local', variant: 'icon', icon: 'clipboardList', iconOnly: true, ariaLabel: 'List snapshots', disabled: true })}
          </div>
        </header>
        ${inlineError({ id: 'local-disk-error' })}
        <div id="local-snapshots"></div>
      </section>

      <section class="${CLS.card}">
        <header class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <p class="${CLS.eyebrow}">Google Drive</p>
              <span id="drive-status"></span>
            </div>
            <p class="text-sm text-slate-500">
              Snapshots go to Drive's hidden <code class="rounded bg-slate-100 px-1 py-0.5 text-xs">appDataFolder</code>.
              Attachments go to a visible <em>Career Planner - Attachments</em> folder.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            ${button({ id: 'btn-connect-drive', variant: 'successIcon', icon: 'link', iconOnly: true, ariaLabel: 'Connect Google Drive' })}
            ${button({ id: 'btn-signout-drive', variant: 'dangerIcon', icon: 'linkSlash', iconOnly: true, ariaLabel: 'Sign out of Google Drive', disabled: true })}
            ${button({ id: 'btn-list-drive', variant: 'icon', icon: 'clipboardList', iconOnly: true, ariaLabel: 'List snapshots', disabled: true })}
          </div>
        </header>
        ${inlineError({ id: 'drive-error' })}
        <div id="drive-snapshots"></div>
      </section>

      <section class="${CLS.card}">
        <div class="space-y-1">
          <p class="${CLS.eyebrow}">Snapshot now</p>
          <p class="text-sm text-slate-500">
            Writes the current database to every connected backend and prunes older copies.
            Add an optional label (e.g. <code class="rounded bg-slate-100 px-1 py-0.5 text-xs">spring-2026</code>) to keep a snapshot forever — labeled snapshots are exempt from retention pruning.
            The download option gives you a portable <code class="rounded bg-slate-100 px-1 py-0.5 text-xs">.sqlite</code> file that works anywhere.
          </p>
        </div>
        ${inlineError({ id: 'snapshot-error' })}
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-sm text-slate-700">
            Keep last
            <input id="keep-count" type="number" min="1" value="5" class="${CLS.inputCompact}">
            auto snapshots
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-700">
            Label
            <input id="snapshot-label" type="text" placeholder="optional, e.g. spring-2026" maxlength="40" class="${CLS.inputCompact}" style="width: 14rem">
          </label>
          ${button({ id: 'btn-snapshot-all', variant: 'primaryCompact', icon: 'camera', label: 'Snapshot all' })}
          ${button({ id: 'btn-download-snapshot', variant: 'icon', icon: 'arrowDownTray', iconOnly: true, ariaLabel: 'Download .sqlite' })}
        </div>
      </section>

      <section class="${CLS.card} border-red-200">
        <div class="space-y-1">
          <p class="${CLS.eyebrow} text-red-700">Danger zone</p>
          <p class="text-sm text-slate-500">
            Wipes the SQLite database (OPFS) and backend metadata (IndexedDB) in this browser.
            Snapshots already saved to Drive or your local folder are <strong>not</strong> touched —
            use them to restore. Useful for simulating a fresh device or total local data loss.
            "Load sample data" replaces the current DB with a 50-application seed for quick demos.
          </p>
        </div>
        ${inlineError({ id: 'danger-error' })}
        <div class="flex flex-wrap items-center gap-3">
          ${button({ id: 'btn-wipe-all', variant: 'dangerCompact', icon: 'trash', label: 'Wipe all local data' })}
          ${button({ id: 'btn-load-sample', variant: 'primaryCompact', icon: 'arrowUpTray', label: 'Load sample data' })}
        </div>
      </section>
    </div>
  `;
};

const renderSnapshotList = (el, list, onRestore, onDelete) => {
  if (!list.length) {
    el.innerHTML = '<div class="rounded-2xl bg-slate-50 px-4 py-4 text-sm text-slate-500">No snapshots yet.</div>';
    return;
  }
  el.innerHTML = `
    <ul class="space-y-2">
      ${list.map(s => `
        <li class="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div class="min-w-0 space-y-1">
            <p class="truncate font-mono text-xs text-slate-800">${escapeHtml(s.name || s.id)}</p>
            <p class="text-xs text-slate-500">${s.createdAt.toLocaleString()} · ${kb(s.sizeBytes)}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            ${button({ variant: 'icon', icon: 'arrowUpTray', iconOnly: true, ariaLabel: `Restore ${s.name || s.id}`, extraClass: 'js-restore', dataset: { id: s.id, name: s.name || s.id } })}
            ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: `Delete ${s.name || s.id}`, extraClass: 'js-delete', dataset: { id: s.id, name: s.name || s.id } })}
          </div>
        </li>`).join('')}
    </ul>
  `;
  el.querySelectorAll('.js-restore').forEach(b => b.addEventListener('click', () => onRestore(b.dataset.id, b.dataset.name)));
  el.querySelectorAll('.js-delete').forEach(b => b.addEventListener('click', () => onDelete(b.dataset.id, b.dataset.name)));
};

// ---------- status refresh ----------
const refreshLocalDisk = () => {
  const status = document.getElementById('disk-status');
  const connect = document.getElementById('btn-connect-disk');
  const forget = document.getElementById('btn-forget-disk');
  const list = document.getElementById('btn-list-local');

  if (localDisk.isReady()) {
    status.innerHTML = badge({ color: 'emerald', size: 'xs', icon: 'link', label: localDisk.dirHandle.name });
    forget.disabled = false;
    list.disabled = false;
    connect.setAttribute('aria-label', 'Reconnect folder');
  } else {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'linkSlash', label: 'not connected' });
    forget.disabled = true;
    list.disabled = true;
  }
};

const refreshDrive = () => {
  const status = document.getElementById('drive-status');
  const signout = document.getElementById('btn-signout-drive');
  const list = document.getElementById('btn-list-drive');

  if (googleDrive.isReady()) {
    const online = navigator.onLine;
    const label = online
      ? (googleDrive.refreshToken ? 'refresh token stored' : 'session only')
      : 'offline';
    status.innerHTML = badge({
      color: online ? 'emerald' : 'amber',
      size: 'xs',
      icon: online ? 'link' : 'linkSlash',
      label,
    });
    signout.disabled = false;
    list.disabled = !online;
  } else {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'linkSlash', label: 'not connected' });
    signout.disabled = true;
    list.disabled = true;
  }
};

const refreshOnlineBanner = () => {
  const el = document.getElementById('online-banner');
  if (!el) return;
  if (navigator.onLine) {
    el.classList.add('hidden');
  } else {
    el.classList.remove('hidden');
    el.textContent = googleDrive.isReady()
      ? 'Offline — Google Drive uploads/reads paused. Local disk (if connected) still works.'
      : 'Offline — cloud backends unavailable.';
  }
};

// ---------- handlers ----------

// Route per-backend errors to their section's banner so users see the message
// next to the affected list, not in a toast at the far corner of the page.
const errorIdFor = (backend) =>
  backend === localDisk ? 'local-disk-error' : 'drive-error';

// `id` is opaque on Drive; `displayName` is the human filename (may equal id
// on local disk). Persist the human name so the sidebar badge shows something
// meaningful across page reloads.
const restoreSnapshot = (backend) => async (id, displayName) => {
  const shown = displayName || id;
  if (!confirm(`Restore ${shown}? Current database contents will be replaced.`)) return;
  const errId = errorIdFor(backend);
  setInlineError(errId, '');
  try {
    const bytes = await backend.loadSnapshot(id);
    await importDb(bytes);
    await setCurrentSnapshotName(shown);
    toast(`Restored ${shown} (${kb(bytes.byteLength)}). Reloading…`, 'ok');
    setTimeout(() => location.reload(), 500);
  } catch (err) {
    setInlineError(errId, `Restore failed: ${err.message}`);
  }
};

const showSnapshotList = async (backend, listEl) => {
  const list = await backend.listSnapshots();
  renderSnapshotList(
    listEl, list,
    restoreSnapshot(backend),
    deleteSnapshot(backend, listEl),
  );
};

const toggleSnapshotList = (backend, listEl) => async () => {
  if (listEl.innerHTML.trim()) {
    listEl.innerHTML = '';
    return;
  }
  const errId = errorIdFor(backend);
  setInlineError(errId, '');
  try {
    await showSnapshotList(backend, listEl);
  } catch (err) {
    setInlineError(errId, `List failed: ${err.message}`);
  }
};

const deleteSnapshot = (backend, listEl) => async (id, displayName) => {
  const shown = displayName || id;
  if (!confirm(`Delete ${shown}? This cannot be undone.`)) return;
  const errId = errorIdFor(backend);
  setInlineError(errId, '');
  try {
    await backend.deleteSnapshot(id);
    toast(`Deleted ${shown}`, 'ok');
    await showSnapshotList(backend, listEl);
  } catch (err) {
    setInlineError(errId, `Delete failed: ${err.message}`);
  }
};

const wireLocalDisk = () => {
  const supportEl = document.getElementById('local-disk-support');
  const connect = document.getElementById('btn-connect-disk');
  const listEl = document.getElementById('local-snapshots');

  if (!LocalDiskBackend.isSupported()) {
    supportEl.innerHTML = '<span class="text-red-600">This browser does not support silent local-folder writes (Firefox/Safari). Use "Download .sqlite" below to export manually.</span>';
    connect.disabled = true;
  } else {
    supportEl.textContent = 'Pick a folder once; on future opens the browser asks to re-allow the same folder in a single click.';
    connect.disabled = false;
  }

  connect.addEventListener('click', async () => {
    setInlineError('local-disk-error', '');
    try {
      await localDisk.connect();
      toast(`Local disk connected: ${localDisk.dirHandle.name}`, 'ok');
      refreshLocalDisk();
    } catch (err) {
      setInlineError('local-disk-error', `Connect failed: ${err.message}`);
    }
  });

  document.getElementById('btn-forget-disk').addEventListener('click', async () => {
    await localDisk.forget();
    listEl.innerHTML = '';
    toast('Forgot saved folder', 'info');
    refreshLocalDisk();
  });

  document.getElementById('btn-list-local').addEventListener('click', toggleSnapshotList(localDisk, listEl));
};

const wireDrive = () => {
  const listEl = document.getElementById('drive-snapshots');

  document.getElementById('btn-connect-drive').addEventListener('click', async () => {
    setInlineError('drive-error', '');
    try {
      await googleDrive.connect();
      toast('Google Drive connected', 'ok');
      refreshDrive();
      refreshOnlineBanner();
    } catch (err) {
      setInlineError('drive-error', `Drive connect failed: ${err.message}`);
    }
  });

  document.getElementById('btn-signout-drive').addEventListener('click', async () => {
    await googleDrive.signOut();
    listEl.innerHTML = '';
    toast('Signed out of Google Drive', 'info');
    refreshDrive();
    refreshOnlineBanner();
  });

  document.getElementById('btn-list-drive').addEventListener('click', toggleSnapshotList(googleDrive, listEl));
};

const wireSnapshotActions = () => {
  document.getElementById('btn-snapshot-all').addEventListener('click', async () => {
    setInlineError('snapshot-error', '');
    const active = availableBackends();
    if (!active.length) {
      setInlineError('snapshot-error', 'No backends available — connect one first (or use Download below)');
      return;
    }
    try {
      const { bytes } = await exportDb();
      const keep = Math.max(1, parseInt(document.getElementById('keep-count').value, 10) || 5);
      const labelInput = document.getElementById('snapshot-label');
      const label = sanitizeSnapshotLabel(labelInput.value);
      const results = await snapshotAllBackends(bytes, { keep, label });
      labelInput.value = '';
      // Labeled snapshot = user-picked checkpoint → treat it as the new current
      // point-in-time for the sidebar badge. Auto (unlabeled) snapshots don't
      // change the "current" identity — they're just retention safety nets.
      if (label) {
        const ok = results.find(r => r.ok && r.meta?.name);
        if (ok) {
          await setCurrentSnapshotName(ok.meta.name);
          refreshCurrentSnapshotBadge();
        }
      }
      const ok = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) {
        toast(`Snapshot saved to ${ok} backend(s)`, 'ok');
      } else {
        const msg = failed.map(f => `${f.backend}: ${f.error}`).join('; ');
        if (ok) toast(`Saved to ${ok}, failed: ${msg}`, 'info');
        else setInlineError('snapshot-error', `Failed: ${msg}`);
      }
    } catch (err) {
      setInlineError('snapshot-error', `Snapshot failed: ${err.message}`);
    }
  });

  document.getElementById('btn-load-sample').addEventListener('click', async () => {
    if (!confirm('Replace the current database with the checked-in sample dataset (50 apps)?')) return;
    setInlineError('danger-error', '');
    try {
      const resp = await fetch('/static/local/samples/sample.sqlite', { cache: 'no-store' });
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      await importDb(bytes);
      // Loading the sample dataset overwrites the DB — the previously-tracked
      // snapshot name no longer describes what's on disk.
      await clearCurrentSnapshotName();
      toast(`Loaded sample (${kb(bytes.byteLength)}). Reloading…`, 'ok');
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      setInlineError('danger-error', `Load sample failed: ${err.message}`);
    }
  });

  document.getElementById('btn-wipe-all').addEventListener('click', async () => {
    const msg = 'Wipe ALL local data?\n\n'
      + '• Clears the SQLite database in this browser (OPFS)\n'
      + '• Forgets Google Drive tokens and the local-folder handle (IndexedDB)\n\n'
      + 'Snapshots on Drive / your picked folder are kept. Type OK to confirm.';
    if (!confirm(msg)) return;
    setInlineError('danger-error', '');
    try {
      await wipeDb();
      disposeWorker();
      // idbWipe deletes the whole meta DB — no need to explicitly clear the
      // current-snapshot key first.
      await idbWipe();
      toast('Local data wiped. Reloading…', 'ok');
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      setInlineError('danger-error', `Wipe failed: ${err.message}`);
    }
  });

  document.getElementById('btn-download-snapshot').addEventListener('click', async () => {
    setInlineError('snapshot-error', '');
    try {
      const { bytes } = await exportDb();
      const label = sanitizeSnapshotLabel(document.getElementById('snapshot-label').value);
      const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = snapshotFilename(new Date(), label);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Downloaded snapshot (${kb(bytes.byteLength)})`, 'ok');
    } catch (err) {
      setInlineError('snapshot-error', `Download failed: ${err.message}`);
    }
  });
};

// ---------- entrypoint ----------
export const mountSettings = async (root) => {
  render(root);
  wireLocalDisk();
  wireDrive();
  wireSnapshotActions();

  // Backends were already restored in main.mjs during boot — just paint status.
  refreshLocalDisk();
  refreshDrive();
  refreshOnlineBanner();

  window.addEventListener('online', () => { refreshDrive(); refreshOnlineBanner(); });
  window.addEventListener('offline', () => { refreshDrive(); refreshOnlineBanner(); });
};
