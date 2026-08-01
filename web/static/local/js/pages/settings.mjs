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
import { refreshScraperModeBadge, invalidateScraperServerStatus } from '../ui/scraper_mode_badge.mjs';
import { idbWipe } from '../storage/idb.mjs';
import { getByokConfig, saveByokConfig, clearByokConfig } from '../storage/byok.mjs';
import { getScraperConfig, saveScraperConfig, clearScraperConfig } from '../storage/scraper.mjs';
import { testConnection, getServerLLMStatus } from '../llm-client.mjs';
import { testConnection as testScraperConnection } from '../scrape-client.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { button, badge, inlineError, setInlineError } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { SUPPORTED, currentLocale, setLocale, localeDisplayName, t } from '../i18n.mjs';

const kb = (n) => `${(n/1024).toFixed(1)} KB`;

const STATUS_CLASS = 'text-sm font-medium';

// ---------- markup ----------
const render = (root) => {
  root.innerHTML = `
    <div class="space-y-6">
      <div id="toast" class="hidden"></div>

      <section class="space-y-2">
        <p class="${CLS.eyebrow}">${t('page.settings.title')}</p>
        <p class="text-sm text-slate-500">
          ${t('settings.section.storage_intro')}
        </p>
      </section>

      <section class="${CLS.card}">
        <header class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="${CLS.eyebrow}">${t('settings.local_disk.eyebrow')}</p>
              <span id="disk-status"></span>
            </div>
            <p class="text-sm text-slate-500" id="local-disk-support"></p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            ${button({ id: 'btn-connect-disk', variant: 'successIcon', icon: 'link', iconOnly: true, ariaLabel: t('settings.local_disk.action.connect'), disabled: true })}
            ${button({ id: 'btn-forget-disk', variant: 'dangerIcon', icon: 'linkSlash', iconOnly: true, ariaLabel: t('settings.local_disk.action.forget'), disabled: true })}
            ${button({ id: 'btn-list-local', variant: 'icon', icon: 'clipboardList', iconOnly: true, ariaLabel: t('settings.local_disk.action.list'), disabled: true })}
          </div>
        </header>
        ${inlineError({ id: 'local-disk-error' })}
        <div id="local-snapshots"></div>
      </section>

      <section class="${CLS.card}">
        <header class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="${CLS.eyebrow}">${t('settings.drive.eyebrow')}</p>
              <span id="drive-status"></span>
            </div>
            <p class="text-sm text-slate-500">
              ${t('settings.drive.help')}
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            ${button({ id: 'btn-connect-drive', variant: 'successIcon', icon: 'link', iconOnly: true, ariaLabel: t('settings.drive.action.connect') })}
            ${button({ id: 'btn-signout-drive', variant: 'dangerIcon', icon: 'linkSlash', iconOnly: true, ariaLabel: t('settings.drive.action.disconnect'), disabled: true })}
            ${button({ id: 'btn-list-drive', variant: 'icon', icon: 'clipboardList', iconOnly: true, ariaLabel: t('settings.drive.action.list'), disabled: true })}
          </div>
        </header>
        ${inlineError({ id: 'drive-error' })}
        <div id="drive-snapshots"></div>
      </section>

      <section class="${CLS.card}">
        <div class="space-y-1">
          <p class="${CLS.eyebrow}">${t('settings.snapshot.eyebrow')}</p>
          <p class="text-sm text-slate-500">
            ${t('settings.snapshot.help_line1')}
            ${t('settings.snapshot.help_line2')}
          </p>
          <p class="text-sm text-slate-500">
            ${t('settings.snapshot.help_line3')}
          </p>
        </div>
        ${inlineError({ id: 'snapshot-error' })}
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-sm text-slate-700">
            ${t('settings.snapshot.keep_last_prefix')}
            <input id="keep-count" type="number" min="1" value="5" class="${CLS.inputCompact}">
            ${t('settings.snapshot.keep_last_suffix')}
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-700">
            ${t('settings.snapshot.label_field')}
            <input id="snapshot-label" type="text" placeholder="${t('settings.snapshot.label_placeholder')}" maxlength="40" class="${CLS.inputCompact}" style="width: 14rem">
          </label>
          ${button({ id: 'btn-snapshot-all', variant: 'primaryCompact', icon: 'camera', label: t('settings.snapshot.action.snapshot_all') })}
          ${button({ id: 'btn-download-snapshot', variant: 'icon', icon: 'arrowDownTray', iconOnly: true, ariaLabel: t('settings.snapshot.action.download') })}
        </div>
      </section>

      <section id="language" class="${CLS.card}">
        <header class="space-y-1">
          <p class="${CLS.eyebrow}">${t('settings.language.label')}</p>
          <p class="text-sm text-slate-500">${t('settings.language.help')}</p>
        </header>
        <label class="block text-sm text-slate-700">
          <select id="locale-select" class="${CLS.input} mt-1">
            ${SUPPORTED.map(code => `<option value="${code}"${code === currentLocale() ? ' selected' : ''}>${localeDisplayName(code)}</option>`).join('')}
          </select>
        </label>
      </section>

      <section id="ai-provider" class="${CLS.card}">
        <header class="space-y-1">
          <div class="flex items-center gap-2">
            <p class="${CLS.eyebrow}">${t('settings.ai.eyebrow')}</p>
            <span id="byok-status"></span>
          </div>
          <p class="text-sm text-slate-500">
            ${t('settings.ai.help')}
          </p>
        </header>
        ${inlineError({ id: 'byok-error' })}
        <div id="byok-fields" class="space-y-3">
          <label class="block text-sm text-slate-700">
            ${t('settings.ai.field.base_url.label')}
            <input id="byok-base-url" type="url" placeholder="https://api.openai.com/v1" class="${CLS.input} mt-1">
          </label>
          <label class="block text-sm text-slate-700">
            ${t('settings.ai.field.model.label')}
            <input id="byok-model" type="text" placeholder="gpt-4o-mini" class="${CLS.input} mt-1">
          </label>
          <label class="block text-sm text-slate-700">
            ${t('settings.ai.field.api_key.label')}
            <span class="ml-1 text-xs text-slate-500">${t('settings.ai.field.api_key.note')}</span>
            <div class="mt-1 flex items-center gap-2">
              <input id="byok-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" class="${CLS.input} flex-1">
              ${button({ id: 'btn-byok-reveal', variant: 'icon', icon: 'eye', iconOnly: true, ariaLabel: t('settings.ai.field.api_key.show') })}
            </div>
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-700">
            <input id="byok-clear-on-signout" type="checkbox" class="h-4 w-4">
            <span>${t('settings.ai.field.clear_with_drive.label')}</span>
          </label>
          <div class="flex flex-wrap items-center gap-3">
            ${button({ id: 'btn-byok-save', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('settings.ai.action.save'), disabled: true })}
            ${button({ id: 'btn-byok-test', variant: 'secondaryCompact', icon: 'link', label: t('settings.ai.action.test') })}
            ${button({ id: 'btn-byok-clear', variant: 'dangerCompact', icon: 'trash', label: t('settings.ai.action.clear') })}
            <span id="byok-test-result" class="text-sm text-slate-600"></span>
          </div>
        </div>
      </section>

      <section id="scraper-provider" class="${CLS.card}">
        <header class="space-y-1">
          <div class="flex items-center gap-2">
            <p class="${CLS.eyebrow}">${t('settings.scraper.eyebrow')}</p>
            <span id="scraper-status"></span>
          </div>
          <p class="text-sm text-slate-500">
            ${t('settings.scraper.help')}
          </p>
        </header>
        ${inlineError({ id: 'scraper-error' })}
        <div id="scraper-fields" class="space-y-3">
          <label class="block text-sm text-slate-700">
            ${t('settings.scraper.field.backend.label')}
            <select id="scraper-backend" class="${CLS.input} mt-1">
              <option value="firecrawl">${t('settings.scraper.field.backend.firecrawl')}</option>
              <option value="crawl4ai">${t('settings.scraper.field.backend.crawl4ai')}</option>
            </select>
          </label>
          <label class="block text-sm text-slate-700">
            ${t('settings.scraper.field.base_url.label')}
            <input id="scraper-base-url" type="url" placeholder="https://api.firecrawl.dev" class="${CLS.input} mt-1">
          </label>
          <label class="block text-sm text-slate-700">
            ${t('settings.scraper.field.api_key.label')}
            <span class="ml-1 text-xs text-slate-500">${t('settings.scraper.field.api_key.note')}</span>
            <div class="mt-1 flex items-center gap-2">
              <input id="scraper-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="fc-…" class="${CLS.input} flex-1">
              ${button({ id: 'btn-scraper-reveal', variant: 'icon', icon: 'eye', iconOnly: true, ariaLabel: t('settings.scraper.field.api_key.show') })}
            </div>
          </label>
          <div class="flex flex-wrap items-center gap-3">
            ${button({ id: 'btn-scraper-save', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('settings.scraper.action.save'), disabled: true })}
            ${button({ id: 'btn-scraper-test', variant: 'secondaryCompact', icon: 'link', label: t('settings.scraper.action.test') })}
            ${button({ id: 'btn-scraper-clear', variant: 'dangerCompact', icon: 'trash', label: t('settings.scraper.action.clear') })}
            <span id="scraper-test-result" class="text-sm text-slate-600"></span>
          </div>
          <p class="text-xs text-slate-500">${t('settings.scraper.capabilities')}</p>
        </div>
      </section>

      <section class="${CLS.card} border-red-200">
        <div class="space-y-1">
          <p class="${CLS.eyebrow} text-red-700">${t('settings.danger.eyebrow')}</p>
          <p class="text-sm text-slate-500">
            ${t('settings.danger.help_line1')}
            ${t('settings.danger.help_line2')}
          </p>
          <p class="text-sm text-slate-500">
            ${t('settings.danger.help_line3')}
          </p>
        </div>
        ${inlineError({ id: 'danger-error' })}
        <div class="flex flex-wrap items-center gap-3">
          ${button({ id: 'btn-wipe-all', variant: 'dangerCompact', icon: 'trash', label: t('settings.danger.action.wipe') })}
          ${button({ id: 'btn-load-sample', variant: 'primaryCompact', icon: 'arrowUpTray', label: t('settings.danger.action.load_sample') })}
        </div>
      </section>
    </div>
  `;
};

const renderSnapshotList = (el, list, onRestore, onDelete) => {
  if (!list.length) {
    el.innerHTML = `<div class="rounded-2xl bg-slate-50 px-4 py-4 text-sm text-slate-500">${t('settings.snapshots.empty')}</div>`;
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
            ${button({ variant: 'icon', icon: 'arrowUpTray', iconOnly: true, ariaLabel: t('settings.snapshots.aria.restore', { name: s.name || s.id }), extraClass: 'js-restore', dataset: { id: s.id, name: s.name || s.id } })}
            ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('settings.snapshots.aria.delete', { name: s.name || s.id }), extraClass: 'js-delete', dataset: { id: s.id, name: s.name || s.id } })}
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
    connect.setAttribute('aria-label', t('settings.local_disk.action.connect'));
  } else {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'linkSlash', label: t('settings.local_disk.badge.not_connected') });
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
      ? (googleDrive.refreshToken ? t('settings.drive.badge.online_refresh') : t('settings.drive.badge.online_session'))
      : t('settings.drive.badge.offline');
    status.innerHTML = badge({
      color: online ? 'emerald' : 'amber',
      size: 'xs',
      icon: online ? 'link' : 'linkSlash',
      label,
    });
    signout.disabled = false;
    list.disabled = !online;
  } else {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'linkSlash', label: t('settings.drive.badge.not_connected') });
    signout.disabled = true;
    list.disabled = true;
  }
};

const refreshByokStatus = async () => {
  const status = document.getElementById('byok-status');
  const [cfg, serverLLM] = await Promise.all([getByokConfig(), getServerLLMStatus()]);
  const byokActive = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
  if (byokActive) {
    status.innerHTML = badge({ color: 'emerald', size: 'xs', icon: 'link', label: t('settings.ai.badge.byok', { model: cfg.model }) });
  } else if (!serverLLM.available) {
    status.innerHTML = badge({ color: 'amber', size: 'xs', icon: 'sparkles', label: t('settings.ai.badge.setup_needed') });
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
      ? t('settings.drive.offline.disabled')
      : t('settings.drive.offline.no_backend');
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
  if (!confirm(t('settings.snapshots.confirm.restore', { name: shown }))) return;
  const errId = errorIdFor(backend);
  setInlineError(errId, '');
  try {
    const bytes = await backend.loadSnapshot(id);
    await importDb(bytes);
    await setCurrentSnapshotName(shown);
    toast(t('settings.snapshots.toast.restored', { name: shown, size: kb(bytes.byteLength) }), 'ok');
    setTimeout(() => location.reload(), 500);
  } catch (err) {
    setInlineError(errId, t('settings.snapshots.error.restore_failed', { err: err.message }));
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
    setInlineError(errId, t('settings.snapshots.error.list_failed', { err: err.message }));
  }
};

const deleteSnapshot = (backend, listEl) => async (id, displayName) => {
  const shown = displayName || id;
  if (!confirm(t('settings.snapshots.confirm.delete', { name: shown }))) return;
  const errId = errorIdFor(backend);
  setInlineError(errId, '');
  try {
    await backend.deleteSnapshot(id);
    toast(t('settings.snapshots.toast.deleted', { name: shown }), 'ok');
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
    revealBtn.setAttribute('aria-label', revealed ? t('settings.ai.field.api_key.hide') : t('settings.ai.field.api_key.show'));
  });

  document.getElementById('btn-byok-test').addEventListener('click', async () => {
    setInlineError('byok-error', '');
    result.textContent = t('settings.ai.test.running');
    const form = readByokForm();
    if (!form.baseUrl || !form.apiKey || !form.model) {
      result.textContent = '';
      setInlineError('byok-error', t('settings.ai.error.test_missing_fields'));
      return;
    }
    const res = await testConnection({ baseUrl: form.baseUrl, apiKey: form.apiKey, model: form.model });
    if (res.ok) {
      result.textContent = t('settings.ai.test.success', { latency: res.latencyMs, count: res.modelsCount });
      lastTestedFingerprint = currentFingerprint();
      syncSaveEnabled();
    } else {
      result.textContent = '';
      setInlineError('byok-error', t('settings.ai.test.failure', { latency: res.latencyMs ?? '—', err: res.error }));
    }
  });

  document.getElementById('btn-byok-save').addEventListener('click', async () => {
    setInlineError('byok-error', '');
    const form = readByokForm();
    if (!form.baseUrl || !form.apiKey || !form.model) {
      setInlineError('byok-error', t('settings.ai.error.save_missing_fields'));
      return;
    }
    await saveByokConfig(form);
    toast(t('settings.ai.toast.enabled', { model: form.model }), 'ok');
    await refreshByokStatus();
  });

  document.getElementById('btn-byok-clear').addEventListener('click', async () => {
    if (!confirm(t('settings.ai.confirm.clear'))) return;
    await clearByokConfig();
    apiKey.value = '';
    result.textContent = '';
    lastTestedFingerprint = null;
    syncSaveEnabled();
    toast(t('settings.ai.toast.cleared'), 'info');
    await refreshByokStatus();
  });
};

const refreshScraperStatus = async () => {
  const status = document.getElementById('scraper-status');
  if (!status) return;
  const [cfg, server] = await Promise.all([
    getScraperConfig(),
    fetch('/api/scrape/server-status').then(r => r.json()).catch(() => ({ available: false })),
  ]);
  const active = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.backend && (cfg.backend !== 'firecrawl' || cfg.apiKey));
  if (active) {
    status.innerHTML = badge({ color: 'emerald', size: 'xs', icon: 'link', label: t('settings.scraper.badge.byok', { backend: cfg.backend }) });
  } else if (server && server.available) {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.scraper.badge.server', { backend: server.backend || '' }) });
  } else {
    status.innerHTML = '';
  }
  // Sidebar badge tracks the same state — refresh it so saves/clears here are
  // reflected immediately without a page reload. Server-status is cached in
  // the badge module; the server-side value cannot change without a redeploy,
  // so we only need to invalidate when we know something changed above.
  invalidateScraperServerStatus();
  refreshScraperModeBadge();
};

const readScraperForm = () => ({
  enabled: true,
  backend: document.getElementById('scraper-backend').value,
  baseUrl: document.getElementById('scraper-base-url').value,
  apiKey: document.getElementById('scraper-api-key').value,
});

const wireScraper = async () => {
  const cfg = await getScraperConfig();
  const backend = document.getElementById('scraper-backend');
  const baseUrl = document.getElementById('scraper-base-url');
  const apiKey = document.getElementById('scraper-api-key');
  const result = document.getElementById('scraper-test-result');
  const saveBtn = document.getElementById('btn-scraper-save');

  backend.value = cfg?.backend || 'firecrawl';
  baseUrl.value = cfg?.baseUrl || (backend.value === 'crawl4ai' ? 'http://localhost:11235' : 'https://api.firecrawl.dev');
  apiKey.value = cfg?.apiKey || '';

  // Test-before-save gate (mirrors AI provider panel).
  const fingerprint = (b, u, k) => `${b}|${u}|${k}`;
  let lastTestedFingerprint = cfg ? fingerprint(cfg.backend, cfg.baseUrl, cfg.apiKey) : null;
  const currentFingerprint = () => fingerprint(backend.value.trim(), baseUrl.value.trim(), apiKey.value.trim());
  const syncSaveEnabled = () => {
    saveBtn.disabled = !lastTestedFingerprint || lastTestedFingerprint !== currentFingerprint();
  };
  syncSaveEnabled();
  [backend, baseUrl, apiKey].forEach(el => el.addEventListener('input', syncSaveEnabled));
  backend.addEventListener('change', () => {
    // Swap the default base URL when the backend changes and the field still
    // holds the old default. Explicit edits are preserved.
    const isFCDefault = baseUrl.value === 'https://api.firecrawl.dev';
    const isC4Default = baseUrl.value === 'http://localhost:11235';
    if (backend.value === 'crawl4ai' && isFCDefault) baseUrl.value = 'http://localhost:11235';
    if (backend.value === 'firecrawl' && isC4Default) baseUrl.value = 'https://api.firecrawl.dev';
    syncSaveEnabled();
  });

  const revealBtn = document.getElementById('btn-scraper-reveal');
  revealBtn.addEventListener('click', () => {
    const revealed = apiKey.type === 'password';
    apiKey.type = revealed ? 'text' : 'password';
    revealBtn.innerHTML = icon(revealed ? 'eyeSlash' : 'eye');
    revealBtn.setAttribute('aria-label', revealed ? t('settings.scraper.field.api_key.hide') : t('settings.scraper.field.api_key.show'));
  });

  document.getElementById('btn-scraper-test').addEventListener('click', async () => {
    setInlineError('scraper-error', '');
    result.textContent = t('settings.scraper.test.running');
    const form = readScraperForm();
    if (!form.backend || !form.baseUrl || (form.backend === 'firecrawl' && !form.apiKey)) {
      result.textContent = '';
      setInlineError('scraper-error', t('settings.scraper.error.test_missing_fields'));
      return;
    }
    const res = await testScraperConnection(form);
    if (res.ok) {
      result.textContent = t('settings.scraper.test.success', { sampleLength: res.sampleLength });
      lastTestedFingerprint = currentFingerprint();
      syncSaveEnabled();
    } else {
      result.textContent = '';
      setInlineError('scraper-error', t('settings.scraper.test.failure', { err: res.error }));
    }
  });

  document.getElementById('btn-scraper-save').addEventListener('click', async () => {
    setInlineError('scraper-error', '');
    const form = readScraperForm();
    if (!form.backend || !form.baseUrl || (form.backend === 'firecrawl' && !form.apiKey)) {
      setInlineError('scraper-error', t('settings.scraper.error.save_missing_fields'));
      return;
    }
    await saveScraperConfig(form);
    toast(t('settings.scraper.toast.enabled', { backend: form.backend }), 'ok');
    await refreshScraperStatus();
  });

  document.getElementById('btn-scraper-clear').addEventListener('click', async () => {
    if (!confirm(t('settings.scraper.confirm.clear'))) return;
    await clearScraperConfig();
    apiKey.value = '';
    result.textContent = '';
    lastTestedFingerprint = null;
    syncSaveEnabled();
    toast(t('settings.scraper.toast.cleared'), 'info');
    await refreshScraperStatus();
  });

  await refreshScraperStatus();
};

const wireLocalDisk = () => {
  const supportEl = document.getElementById('local-disk-support');
  const connect = document.getElementById('btn-connect-disk');
  const listEl = document.getElementById('local-snapshots');

  if (!LocalDiskBackend.isSupported()) {
    supportEl.innerHTML = `<span class="text-red-600">${t('settings.local_disk.unsupported')}</span>`;
    connect.disabled = true;
  } else {
    supportEl.textContent = t('settings.local_disk.help');
    connect.disabled = false;
  }

  connect.addEventListener('click', async () => {
    setInlineError('local-disk-error', '');
    try {
      await localDisk.connect();
      toast(t('settings.local_disk.toast.connected', { folder: localDisk.dirHandle.name }), 'ok');
      refreshLocalDisk();
    } catch (err) {
      setInlineError('local-disk-error', t('settings.local_disk.error.connect_failed', { err: err.message }));
    }
  });

  document.getElementById('btn-forget-disk').addEventListener('click', async () => {
    await localDisk.forget();
    listEl.innerHTML = '';
    toast(t('settings.local_disk.toast.forgot'), 'info');
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
      toast(t('settings.drive.toast.connected'), 'ok');
      refreshDrive();
      refreshOnlineBanner();
    } catch (err) {
      setInlineError('drive-error', t('settings.drive.error.connect_failed', { err: err.message }));
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
    toast(t('settings.drive.toast.disconnected'), 'info');
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
      setInlineError('snapshot-error', t('settings.snapshot.error.no_backends'));
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
        toast(t('settings.snapshot.toast.saved', { n: ok }), 'ok');
      } else {
        const msg = failed.map(f => `${f.backend}: ${f.error}`).join('; ');
        if (ok) toast(t('settings.snapshot.toast.partial', { ok, failed: msg }), 'info');
        else setInlineError('snapshot-error', t('settings.snapshot.error.all_failed', { msg }));
      }
    } catch (err) {
      setInlineError('snapshot-error', t('settings.snapshot.error.failed', { err: err.message }));
    }
  });

  document.getElementById('btn-load-sample').addEventListener('click', async () => {
    if (!confirm(t('settings.danger.confirm.load_sample'))) return;
    setInlineError('danger-error', '');
    try {
      const resp = await fetch('/static/local/samples/sample.sqlite', { cache: 'no-store' });
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      await importDb(bytes);
      // Loading the sample dataset overwrites the DB — the previously-tracked
      // snapshot name no longer describes what's on disk.
      await clearCurrentSnapshotName();
      toast(t('settings.danger.toast.sample_loaded', { size: kb(bytes.byteLength) }), 'ok');
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      setInlineError('danger-error', t('settings.danger.error.sample_failed', { err: err.message }));
    }
  });

  document.getElementById('btn-wipe-all').addEventListener('click', async () => {
    if (!confirm(t('settings.danger.confirm.wipe'))) return;
    setInlineError('danger-error', '');
    try {
      await wipeDb();
      disposeWorker();
      // idbWipe deletes the whole meta DB — no need to explicitly clear the
      // current-snapshot key first.
      await idbWipe();
      toast(t('settings.danger.toast.wiped'), 'ok');
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      setInlineError('danger-error', t('settings.danger.error.wipe_failed', { err: err.message }));
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
      toast(t('settings.snapshot.toast.downloaded', { size: kb(bytes.byteLength) }), 'ok');
    } catch (err) {
      setInlineError('snapshot-error', t('settings.snapshot.error.download_failed', { err: err.message }));
    }
  });
};

// wireLocale is fire-and-reload: setLocale() persists the choice + writes the
// `lang` cookie, then reloads so the server-rendered shell re-renders with the
// new locale. Nothing else on the page depends on the current selection.
const wireLocale = () => {
  const select = document.getElementById('locale-select');
  if (!select) return;
  select.addEventListener('change', async (e) => {
    try {
      await setLocale(e.target.value);
    } catch (err) {
      console.error('[settings] setLocale', err);
      toast(t('settings.language.error'), { level: 'error' });
    }
  });
};

// ---------- entrypoint ----------
export const mountSettings = async (root) => {
  render(root);
  wireLocale();
  await wireByok();
  await wireScraper();
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
