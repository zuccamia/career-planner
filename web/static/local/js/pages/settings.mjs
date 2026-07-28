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
import { refreshAiModeBadge } from '../ui/ai_mode_badge.mjs';
import { idbWipe } from '../storage/idb.mjs';
import { getByokConfig, saveByokConfig, clearByokConfig } from '../storage/byok.mjs';
import { testConnection, getServerLLMStatus } from '../llm-client.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { button, badge, inlineError, setInlineError } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';

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

      <section id="ai-provider" class="${CLS.card}">
        <header class="space-y-1">
          <div class="flex items-center gap-2">
            <p class="${CLS.eyebrow}">AI provider</p>
            <span id="byok-status"></span>
          </div>
          <p class="text-sm text-slate-500">
            Bring your own OpenAI-compatible key. The browser calls your provider directly;
            the server assembles prompts and sanitizes responses, but never sees the key.
            Stored in this browser's IndexedDB.
          </p>
        </header>
        ${inlineError({ id: 'byok-error' })}
        <div id="byok-fields" class="space-y-3">
          <label class="block text-sm text-slate-700">
            Base URL
            <input id="byok-base-url" type="url" placeholder="https://api.openai.com/v1" class="${CLS.input} mt-1">
          </label>
          <label class="block text-sm text-slate-700">
            Model
            <input id="byok-model" type="text" placeholder="gpt-4o-mini" class="${CLS.input} mt-1">
          </label>
          <label class="block text-sm text-slate-700">
            API key
            <span class="ml-1 text-xs text-slate-500">(stored only in this browser)</span>
            <div class="mt-1 flex items-center gap-2">
              <input id="byok-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" class="${CLS.input} flex-1">
              ${button({ id: 'btn-byok-reveal', variant: 'icon', icon: 'eye', iconOnly: true, ariaLabel: 'Show API key' })}
            </div>
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-700">
            <input id="byok-clear-on-signout" type="checkbox" class="h-4 w-4">
            <span>Clear my key when I sign out of Google Drive</span>
          </label>
          <div class="flex flex-wrap items-center gap-3">
            ${button({ id: 'btn-byok-save', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: 'Save AI provider settings', disabled: true })}
            ${button({ id: 'btn-byok-test', variant: 'secondaryCompact', icon: 'link', label: 'Test connection' })}
            ${button({ id: 'btn-byok-clear', variant: 'dangerCompact', icon: 'trash', label: 'Clear key' })}
            <span id="byok-test-result" class="text-sm text-slate-600"></span>
          </div>
        </div>
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
            "Load sample data" replaces the current DB with a seed dataset (profile overview,
            sparks, 2 resumes, 3 brag entries, 12 companies, 24 people, 50 applications) for quick demos.
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

const refreshByokStatus = async () => {
  const status = document.getElementById('byok-status');
  const [cfg, serverLLM] = await Promise.all([getByokConfig(), getServerLLMStatus()]);
  const byokActive = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
  if (byokActive) {
    status.innerHTML = badge({ color: 'emerald', size: 'xs', icon: 'link', label: `BYOK · ${cfg.model}` });
  } else if (!serverLLM.available) {
    status.innerHTML = badge({ color: 'amber', size: 'xs', icon: 'sparkles', label: 'setup needed' });
  } else {
    status.innerHTML = '';
  }
  // Sidebar badge tracks the same state — refresh it so saves/clears here
  // are reflected immediately without a page reload.
  refreshAiModeBadge();
};

// readByokForm collects the form values into the persisted shape. Does not
// validate — callers (test / save) surface field-level errors themselves.
// enabled is implicitly true: the only way to persist a config through this
// form is BYOK-on. "Clear key" is the escape hatch back to the server-side LLM.
const readByokForm = () => ({
  enabled: true,
  baseUrl: document.getElementById('byok-base-url').value,
  model: document.getElementById('byok-model').value,
  apiKey: document.getElementById('byok-api-key').value,
  clearOnSignOut: document.getElementById('byok-clear-on-signout').checked,
});

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

const wireByok = async () => {
  const cfg = await getByokConfig();
  const baseUrl = document.getElementById('byok-base-url');
  const model = document.getElementById('byok-model');
  const apiKey = document.getElementById('byok-api-key');
  const clearOnSignout = document.getElementById('byok-clear-on-signout');
  const result = document.getElementById('byok-test-result');
  const saveBtn = document.getElementById('btn-byok-save');

  baseUrl.value = cfg?.baseUrl || 'https://api.openai.com/v1';
  model.value = cfg?.model || 'gpt-4o-mini';
  apiKey.value = cfg?.apiKey || '';
  clearOnSignout.checked = !!cfg?.clearOnSignOut;

  // Test-before-save gate: Save is disabled until Test connection succeeds
  // for the current field values. Any edit to baseUrl/model/apiKey clears
  // the "tested" state so users can't save credentials we haven't verified.
  // Seeded from persisted cfg on load — a config that was saved previously
  // must have passed the gate at some point, so we trust it across reloads.
  const fingerprint = (b, m, k) => `${b}|${m}|${k}`;
  let lastTestedFingerprint = cfg ? fingerprint(cfg.baseUrl, cfg.model, cfg.apiKey) : null;
  const currentFingerprint = () => fingerprint(baseUrl.value.trim(), model.value.trim(), apiKey.value.trim());
  const syncSaveEnabled = () => {
    saveBtn.disabled = !lastTestedFingerprint || lastTestedFingerprint !== currentFingerprint();
  };
  syncSaveEnabled();
  [baseUrl, model, apiKey].forEach(el => el.addEventListener('input', syncSaveEnabled));

  const revealBtn = document.getElementById('btn-byok-reveal');
  revealBtn.addEventListener('click', () => {
    const revealed = apiKey.type === 'password';
    apiKey.type = revealed ? 'text' : 'password';
    revealBtn.innerHTML = icon(revealed ? 'eyeSlash' : 'eye');
    revealBtn.setAttribute('aria-label', revealed ? 'Hide API key' : 'Show API key');
  });

  document.getElementById('btn-byok-test').addEventListener('click', async () => {
    setInlineError('byok-error', '');
    result.textContent = 'Testing…';
    const form = readByokForm();
    if (!form.baseUrl || !form.apiKey) {
      result.textContent = '';
      setInlineError('byok-error', 'Base URL and API key are required to test.');
      return;
    }
    const res = await testConnection({ baseUrl: form.baseUrl, apiKey: form.apiKey });
    if (res.ok) {
      result.textContent = `✓ Reached provider in ${res.latencyMs}ms (${res.modelsCount} models listed)`;
      lastTestedFingerprint = currentFingerprint();
      syncSaveEnabled();
    } else {
      result.textContent = '';
      setInlineError('byok-error', `Test failed (${res.latencyMs ?? '—'}ms): ${res.error}`);
    }
  });

  document.getElementById('btn-byok-save').addEventListener('click', async () => {
    setInlineError('byok-error', '');
    const form = readByokForm();
    if (!form.baseUrl || !form.apiKey || !form.model) {
      setInlineError('byok-error', 'Base URL, model, and API key are required to enable BYOK.');
      return;
    }
    await saveByokConfig(form);
    toast(`BYOK enabled · ${form.model}`, 'ok');
    await refreshByokStatus();
  });

  document.getElementById('btn-byok-clear').addEventListener('click', async () => {
    if (!confirm('Clear the saved API key from this browser?')) return;
    await clearByokConfig();
    apiKey.value = '';
    result.textContent = '';
    lastTestedFingerprint = null;
    syncSaveEnabled();
    toast('BYOK key cleared', 'info');
    await refreshByokStatus();
  });
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
    // Respect the BYOK "clear on signout" preference — some users treat the
    // Drive session as their trust anchor for whether personal creds should
    // persist on this machine.
    const cfg = await getByokConfig();
    if (cfg?.clearOnSignOut) {
      await clearByokConfig();
      const apiKey = document.getElementById('byok-api-key');
      if (apiKey) apiKey.value = '';
      await refreshByokStatus();
    }
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
    if (!confirm('Replace the current database with the checked-in sample dataset (profile + 12 companies + 24 people + 50 apps)?')) return;
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
  await wireByok();
  wireLocalDisk();
  wireDrive();
  wireSnapshotActions();

  // Backends were already restored in main.mjs during boot — just paint status.
  refreshLocalDisk();
  refreshDrive();
  refreshOnlineBanner();
  await refreshByokStatus();

  window.addEventListener('online', () => { refreshDrive(); refreshOnlineBanner(); });
  window.addEventListener('offline', () => { refreshDrive(); refreshOnlineBanner(); });
};
