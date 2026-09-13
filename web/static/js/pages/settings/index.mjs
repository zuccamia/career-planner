// Settings page: manage the two storage backends (local disk, Google Drive)
// and take manual snapshots. Styling uses the shared "cool-ledger" tokens
// (brand teal, ink text, brass accents) via CLS + tailwind.css theme variables.

import { exportDb, importDb, wipeDb, disposeWorker } from '../../db/client.mjs';
import {
  localDisk, googleDrive,
  availableBackends,
} from '../../storage/index.mjs';
import { LocalDiskBackend } from '../../storage/local-disk.mjs';
import { reconcileAttachments, getLastAttachmentReconcileAt } from '../../storage/reconcile.mjs';
import { isAutosyncEnabled, setAutosyncEnabled } from '../../storage/autosync.mjs';
import { deleteAttachment } from '../../entities/attachments.mjs';
import {
  syncCurrentSnapshot, getActiveSyncLabel, hasUnsyncedLocalChanges,
  finalizeSyncResult, markRestoredFromSnapshot, clearLocalModifiedAt,
  getLastSyncedAt, getDivergenceState, resolveDivergence,
} from '../../storage/sync-current.mjs';
import { relativeAge } from '../../ui/format.mjs';
import { snapshotFilename, sanitizeSnapshotLabel } from '../../storage/config.mjs';
import { STATIC_ROOT } from '../../host.mjs';
import {
  setCurrentSnapshotName, clearCurrentSnapshotName,
} from '../../storage/current-snapshot.mjs';
import { refreshAiModeBadge } from '../../ui/ai_mode_badge.mjs';
import { refreshScraperModeBadge } from '../../ui/scraper_mode_badge.mjs';
import { refreshSearchModeBadge } from '../../ui/search_mode_badge.mjs';
import { refreshStorageModeBadge } from '../../ui/storage_mode_badge.mjs';
import { idbWipe } from '../../storage/idb.mjs';
import {
  getByokLLMConfig, saveByokLLMConfig, clearByokLLMConfig,
  DEFAULT_BASE_URL as DEFAULT_LLM_BASE_URL, DEFAULT_MODEL as DEFAULT_LLM_MODEL,
} from '../../storage/byok-llm.mjs';
import {
  getByokScraperConfig, saveByokScraperConfig, clearByokScraperConfig,
  PROVIDERS as SCRAPER_PROVIDERS, PROVIDER_KEYS as SCRAPER_PROVIDER_KEYS,
  DEFAULT_PROVIDER as DEFAULT_SCRAPER_PROVIDER,
} from '../../storage/byok-scraper.mjs';
import {
  getByokSearchConfig, saveByokSearchConfig, clearByokSearchConfig,
  PROVIDER_KEYS as SEARCH_PROVIDER_KEYS, DEFAULT_PROVIDER as DEFAULT_SEARCH_PROVIDER,
  DEFAULT_MAX_RESULTS as DEFAULT_SEARCH_MAX,
} from '../../storage/byok-search.mjs';
import { testConnection, getServerLLMStatus } from '../../sources/llm/client.mjs';
import { testConnection as testScraperConnection, getServerScraperStatus } from '../../sources/scrape/client.mjs';
import { testConnection as testSearchConnection } from '../../sources/search/client.mjs';
import { getServerDiscoverStatus } from '../../clients/discover/service.mjs';
import { escapeHtml } from '../../ui/dom.mjs';
import { CLS } from '../../ui/classes.mjs';
import { toast } from '../../ui/toast.mjs';
import { button, badge, emptyState, helpText, inlineError, setInlineError, pageHeader } from '../../ui/components.mjs';
import {
  byokSectionHeader, byokProviderRow, byokBaseURLRow, byokAPIKeyRow, byokActionsRow, wireByokPanel,
} from '../../ui/byok_panel.mjs';
import { SUPPORTED, currentLocale, setLocale, localeDisplayName, t } from '../../i18n.mjs';

const kb = (n) => `${(n/1024).toFixed(1)} KB`;

const STATUS_CLASS = 'text-sm font-medium';

// ---------- markup ----------
const render = (root) => {
  root.innerHTML = `
    <div class="space-y-6">
      <div id="toast" class="hidden"></div>

      <section class="space-y-2">
        ${pageHeader({ page: 'settings', title: t('page.settings.title'), tagline: t('settings.section.storage_intro') })}
      </section>

      <section class="${CLS.card}">
        <header class="${CLS.cardHeadRow}">
          <div class="${CLS.flexTextCol}">
            <div class="${CLS.chipRowInline}">
              <p class="${CLS.eyebrow}">${t('settings.local_disk.eyebrow')}</p>
              <span id="disk-status"></span>
            </div>
            ${helpText('', { id: 'local-disk-support' })}
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
        <header class="${CLS.cardHeadRow}">
          <div class="${CLS.flexTextCol}">
            <div class="${CLS.chipRowInline}">
              <p class="${CLS.eyebrow}">${t('settings.drive.eyebrow')}</p>
              <span id="drive-status"></span>
            </div>
            ${helpText(t('settings.drive.help'))}
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

      <div id="divergence-banner" class="hidden"></div>

      <section id="sync-panel" class="${CLS.card}">
        <div class="space-y-1">
          <p class="${CLS.eyebrow}">${t('settings.sync.eyebrow')}</p>
          ${helpText(t('settings.sync.help_line1'))}
          ${helpText(t('settings.sync.help_line2'))}
        </div>
        ${inlineError({ id: 'sync-error' })}
        <div class="${CLS.formRow}">
          <label class="${CLS.responsiveRow} ${CLS.bodyText}">
            ${t('settings.sync.label_field')}
            <input id="sync-label" type="text" placeholder="${t('settings.sync.label_placeholder')}" maxlength="40" class="${CLS.inputCompact}" style="width: 14rem">
          </label>
          ${button({ id: 'btn-sync', variant: 'primaryCompact', icon: 'arrowPath', label: t('settings.sync.action.sync') })}
          ${button({ id: 'btn-download-snapshot', variant: 'icon', icon: 'arrowDownTray', iconOnly: true, ariaLabel: t('settings.sync.action.download') })}
          <span id="sync-status" class="${CLS.bodyText} text-slate-500"></span>
        </div>
        <p id="sync-last" class="${CLS.helpText}"></p>
        <label class="${CLS.rowInline} ${CLS.bodyText}">
          <input id="autosync-toggle" type="checkbox" class="${CLS.checkbox}">
          <span>${t('settings.sync.autosync.label')}</span>
        </label>
        ${helpText(t('settings.sync.autosync.help'))}
      </section>

      <section class="${CLS.card}">
        <div class="space-y-1">
          <p class="${CLS.eyebrow}">${t('settings.reconcile.eyebrow')}</p>
          ${helpText(t('settings.reconcile.help'))}
        </div>
        ${inlineError({ id: 'reconcile-error' })}
        <div class="${CLS.formRow}">
          ${button({ id: 'btn-reconcile-attachments', variant: 'primaryCompact', icon: 'arrowPath', label: t('settings.reconcile.action.run') })}
          <span id="reconcile-status" class="${CLS.bodyText} text-slate-500"></span>
        </div>
        <p id="reconcile-last" class="${CLS.helpText}"></p>
      </section>

      <section id="language" class="${CLS.card}">
        <header class="space-y-1">
          <p class="${CLS.eyebrow}">${t('settings.language.label')}</p>
          ${helpText(t('settings.language.help'))}
        </header>
        <label class="block ${CLS.bodyText}">
          <select id="locale-select" class="${CLS.input} mt-1">
            ${SUPPORTED.map(code => `<option value="${code}"${code === currentLocale() ? ' selected' : ''}>${localeDisplayName(code)}</option>`).join('')}
          </select>
        </label>
      </section>

      <section id="ai-panel" class="${CLS.card}">
        ${byokSectionHeader({ domPrefix: 'llm', i18nPrefix: 'settings.ai' })}
        <div id="llm-fields" class="space-y-3">
          ${byokBaseURLRow({ domPrefix: 'llm', i18nPrefix: 'settings.ai', placeholder: DEFAULT_LLM_BASE_URL })}
          <label class="block ${CLS.bodyText}">
            ${t('settings.ai.field.model.label')}
            <input id="llm-model" type="text" placeholder="${DEFAULT_LLM_MODEL}" class="${CLS.input} mt-1">
          </label>
          ${byokAPIKeyRow({ domPrefix: 'llm', i18nPrefix: 'settings.ai', placeholder: 'sk-…', hasNote: true })}
          <label class="${CLS.rowInline} ${CLS.bodyText}">
            <input id="llm-clear-on-signout" type="checkbox" class="h-4 w-4">
            <span>${t('settings.ai.field.clear_with_drive.label')}</span>
          </label>
          ${byokActionsRow({ domPrefix: 'llm', i18nPrefix: 'settings.ai' })}
        </div>
      </section>

      <section id="scraper-panel" class="${CLS.card}">
        ${byokSectionHeader({ domPrefix: 'scraper', i18nPrefix: 'settings.scraper' })}
        <div id="scraper-fields" class="space-y-3">
          ${byokProviderRow({ domPrefix: 'scraper', i18nPrefix: 'settings.scraper', options: SCRAPER_PROVIDER_KEYS })}
          ${byokBaseURLRow({ domPrefix: 'scraper', i18nPrefix: 'settings.scraper', placeholder: SCRAPER_PROVIDERS[DEFAULT_SCRAPER_PROVIDER].defaultBaseUrl })}
          ${byokAPIKeyRow({ domPrefix: 'scraper', i18nPrefix: 'settings.scraper', placeholder: 'fc-…', hasNote: true })}
          ${byokActionsRow({ domPrefix: 'scraper', i18nPrefix: 'settings.scraper' })}
          ${helpText(t('settings.scraper.capabilities'))}
        </div>
      </section>

      <section id="search-panel" class="${CLS.card}">
        ${byokSectionHeader({ domPrefix: 'search', i18nPrefix: 'settings.search' })}
        <div id="search-fields" class="space-y-3">
          ${byokProviderRow({ domPrefix: 'search', i18nPrefix: 'settings.search', options: SEARCH_PROVIDER_KEYS })}
          ${byokAPIKeyRow({ domPrefix: 'search', i18nPrefix: 'settings.search', placeholder: t('settings.search.field.api_key.placeholder') })}
          <label class="block ${CLS.bodyText}">
            ${t('settings.search.field.max_results.label')}
            <input id="search-max-results" type="number" min="1" max="50" value="${DEFAULT_SEARCH_MAX}" class="${CLS.inputCompact} mt-1">
            <span class="ml-1 ${CLS.helpText}">${t('settings.search.field.max_results.help')}</span>
          </label>
          ${byokActionsRow({ domPrefix: 'search', i18nPrefix: 'settings.search' })}
        </div>
      </section>

      <section class="${CLS.card} border-status-out/30">
        <div class="space-y-1">
          <p class="${CLS.eyebrow} text-status-out">${t('settings.danger.eyebrow')}</p>
          ${helpText(`${t('settings.danger.help_line1')} ${t('settings.danger.help_line2')}`)}
          ${helpText(t('settings.danger.help_line3'))}
        </div>
        ${inlineError({ id: 'danger-error' })}
        <div class="${CLS.formRow}">
          ${button({ id: 'btn-wipe-all', variant: 'dangerCompact', icon: 'trash', label: t('settings.danger.action.wipe') })}
          ${button({ id: 'btn-load-sample', variant: 'primaryCompact', icon: 'arrowUpTray', label: t('settings.danger.action.load_sample') })}
        </div>
      </section>
    </div>
  `;
};

const renderSnapshotList = (el, list, onRestore, onDelete) => {
  if (!list.length) {
    el.innerHTML = emptyState({ message: t('settings.snapshots.empty') });
    return;
  }
  el.innerHTML = `
    <ul class="space-y-2">
      ${list.map(s => `
        <li class="flex items-center justify-between gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
          <div class="${CLS.textCol}">
            <p class="truncate font-mono text-xs text-ink">${escapeHtml(s.name || s.id)}</p>
            <p class="${CLS.helpText}">${s.createdAt.toLocaleString()} · ${kb(s.sizeBytes)}</p>
          </div>
          <div class="${CLS.headActions}">
            ${button({ variant: 'icon', icon: 'arrowUpTray', iconOnly: true, ariaLabel: t('settings.snapshots.aria.restore', { name: s.name || s.id }), extraClass: 'js-restore', dataset: { id: s.id, name: s.name || s.id, mtime: s.createdAt.getTime() } })}
            ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('settings.snapshots.aria.delete', { name: s.name || s.id }), extraClass: 'js-delete', dataset: { id: s.id, name: s.name || s.id } })}
          </div>
        </li>`).join('')}
    </ul>
  `;
  el.querySelectorAll('.js-restore').forEach(b => b.addEventListener('click', () => onRestore(b.dataset.id, b.dataset.name, Number(b.dataset.mtime))));
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

const refreshByokLLMStatus = async () => {
  const status = document.getElementById('llm-status');
  if (!status) return;
  const [cfg, serverLLM] = await Promise.all([getByokLLMConfig(), getServerLLMStatus()]);
  const byokActive = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
  if (byokActive) {
    status.innerHTML = badge({ color: 'emerald', size: 'xs', icon: 'link', label: t('settings.ai.badge.byok', { model: cfg.model }) });
  } else if (serverLLM.available) {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.ai.badge.server', { model: serverLLM.model || '' }) });
  } else {
    status.innerHTML = badge({ color: 'amber', size: 'xs', icon: 'sparkles', label: t('settings.ai.badge.setup_needed') });
  }
  // Sidebar badge tracks the same state — refresh it so saves/clears here
  // are reflected immediately without a page reload.
  refreshAiModeBadge();
};

// ---------- handlers ----------

// Route per-backend errors to their section's banner so users see the message
// next to the affected list, not in a toast at the far corner of the page.
const errorIdFor = (backend) =>
  backend === localDisk ? 'local-disk-error' : 'drive-error';

// `id` is opaque on Drive; `displayName` is the human filename (may equal id
// on local disk). Persist the human name so the sidebar badge shows something
// meaningful across page reloads.
const restoreSnapshot = (backend) => async (id, displayName, mtimeMs) => {
  const shown = displayName || id;
  if (!confirm(t('settings.snapshots.confirm.restore', { name: shown }))) return;
  const errId = errorIdFor(backend);
  setInlineError(errId, '');
  try {
    const bytes = await backend.loadSnapshot(id);
    await importDb(bytes);
    await setCurrentSnapshotName(shown);
    // Stamp local's timestamp as the snapshot's own mtime — a fresher backend
    // copy of the sync file will still win on the next sync (restore = viewing).
    if (mtimeMs) await markRestoredFromSnapshot(mtimeMs);
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

const wireByokLLM = async () => {
  const baseUrl = document.getElementById('llm-base-url');
  const model = document.getElementById('llm-model');
  const apiKey = document.getElementById('llm-api-key');
  const clearOnSignout = document.getElementById('llm-clear-on-signout');
  await wireByokPanel({
    domPrefix: 'llm',
    i18nPrefix: 'settings.ai',
    fieldEls: [baseUrl, model, apiKey],
    apiKeyEl: apiKey,
    loadConfig: getByokLLMConfig,
    saveConfig: saveByokLLMConfig,
    clearConfig: clearByokLLMConfig,
    hydrateForm: (cfg) => {
      baseUrl.value = cfg?.baseUrl || DEFAULT_LLM_BASE_URL;
      model.value = cfg?.model || DEFAULT_LLM_MODEL;
      apiKey.value = cfg?.apiKey || '';
      clearOnSignout.checked = !!cfg?.clearOnSignOut;
    },
    // enabled is implicitly true — the only way to persist through this
    // form is BYOK-on. "Clear key" is the escape hatch back to server LLM.
    readForm: () => ({
      enabled: true,
      baseUrl: baseUrl.value.trim(),
      model: model.value.trim(),
      apiKey: apiKey.value.trim(),
      clearOnSignOut: clearOnSignout.checked,
    }),
    fingerprintOf: (o) => `${o.baseUrl || ''}|${o.model || ''}|${o.apiKey || ''}`,
    validate: (f) => !!(f.baseUrl && f.apiKey && f.model),
    runTest: (f) => testConnection({ baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.model }),
    formatTestSuccess: (r) => t('settings.ai.test.success', { latency: r.latencyMs, count: r.modelsCount }),
    formatSavedToast: (f) => t('settings.ai.toast.enabled', { model: f.model }),
    onChange: refreshByokLLMStatus,
  });
};

const refreshByokScraperStatus = async () => {
  const status = document.getElementById('scraper-status');
  if (!status) return;
  const [cfg, server] = await Promise.all([
    getByokScraperConfig(),
    getServerScraperStatus(),
  ]);
  const needsKey = SCRAPER_PROVIDERS[cfg?.provider]?.requiresApiKey;
  const active = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.provider && (!needsKey || cfg.apiKey));
  if (active) {
    status.innerHTML = badge({ color: 'emerald', size: 'xs', icon: 'link', label: t('settings.scraper.badge.byok', { provider: cfg.provider }) });
  } else if (server && server.available) {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.scraper.badge.server', { provider: server.provider || '' }) });
  } else {
    status.innerHTML = '';
  }
  // Sidebar badge tracks the same state — refresh so saves/clears here
  // reflect immediately without a page reload.
  refreshScraperModeBadge();
};

const wireByokScraper = async () => {
  const provider = document.getElementById('scraper-provider');
  const baseUrl = document.getElementById('scraper-base-url');
  const apiKey = document.getElementById('scraper-api-key');
  await wireByokPanel({
    domPrefix: 'scraper',
    i18nPrefix: 'settings.scraper',
    fieldEls: [provider, baseUrl, apiKey],
    apiKeyEl: apiKey,
    extraChangeEls: [provider],
    loadConfig: getByokScraperConfig,
    saveConfig: saveByokScraperConfig,
    clearConfig: clearByokScraperConfig,
    hydrateForm: (cfg) => {
      provider.value = cfg?.provider || DEFAULT_SCRAPER_PROVIDER;
      baseUrl.value = cfg?.baseUrl || SCRAPER_PROVIDERS[provider.value].defaultBaseUrl;
      apiKey.value = cfg?.apiKey || '';
    },
    readForm: () => ({
      enabled: true,
      provider: provider.value,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
    }),
    fingerprintOf: (o) => `${o.provider || ''}|${o.baseUrl || ''}|${o.apiKey || ''}`,
    validate: (f) => !!(f.provider && f.baseUrl && (!SCRAPER_PROVIDERS[f.provider]?.requiresApiKey || f.apiKey)),
    runTest: testScraperConnection,
    formatTestSuccess: (r) => t('settings.scraper.test.success', { sampleLength: r.sampleLength }),
    formatSavedToast: (f) => t('settings.scraper.toast.enabled', { provider: f.provider }),
    onChange: refreshByokScraperStatus,
  });

  // Swap the default base URL when the provider changes and the field still
  // holds a different provider's default. Explicit edits are preserved.
  const isDefaultBaseUrl = () =>
    SCRAPER_PROVIDER_KEYS.some((k) => SCRAPER_PROVIDERS[k].defaultBaseUrl === baseUrl.value);
  provider.addEventListener('change', () => {
    if (isDefaultBaseUrl()) baseUrl.value = SCRAPER_PROVIDERS[provider.value].defaultBaseUrl;
  });

  await refreshByokScraperStatus();
};

const refreshByokSearchStatus = async () => {
  const status = document.getElementById('search-status');
  if (!status) return;
  const [cfg, server] = await Promise.all([
    getByokSearchConfig(),
    getServerDiscoverStatus(),
  ]);
  const active = !!(cfg && cfg.enabled && cfg.provider && cfg.apiKey);
  if (active) {
    status.innerHTML = badge({ color: 'emerald', size: 'xs', icon: 'link', label: t('settings.search.badge.byok', { provider: cfg.provider }) });
  } else if (server && server.search_available) {
    status.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.search.badge.server', { provider: server.provider || '' }) });
  } else {
    status.innerHTML = '';
  }
  refreshSearchModeBadge();
};

const wireByokSearch = async () => {
  const provider = document.getElementById('search-provider');
  const apiKey = document.getElementById('search-api-key');
  const maxResults = document.getElementById('search-max-results');
  await wireByokPanel({
    domPrefix: 'search',
    i18nPrefix: 'settings.search',
    fieldEls: [provider, apiKey, maxResults],
    apiKeyEl: apiKey,
    extraChangeEls: [provider],
    loadConfig: getByokSearchConfig,
    saveConfig: saveByokSearchConfig,
    clearConfig: clearByokSearchConfig,
    hydrateForm: (cfg) => {
      provider.value = cfg?.provider || DEFAULT_SEARCH_PROVIDER;
      apiKey.value = cfg?.apiKey || '';
      maxResults.value = cfg?.maxResults || DEFAULT_SEARCH_MAX;
    },
    readForm: () => ({
      enabled: true,
      provider: provider.value,
      apiKey: apiKey.value.trim(),
      maxResults: parseInt(maxResults.value, 10) || DEFAULT_SEARCH_MAX,
    }),
    fingerprintOf: (o) => `${o.provider || ''}|${o.apiKey || ''}|${o.maxResults ?? ''}`,
    validate: (f) => !!(f.provider && f.apiKey),
    runTest: testSearchConnection,
    formatTestSuccess: (r) => t('settings.search.test.success', { sampleCount: r.sampleCount }),
    formatSavedToast: (f) => t('settings.search.toast.enabled', { provider: f.provider }),
    onChange: refreshByokSearchStatus,
  });

  await refreshByokSearchStatus();
};

const wireLocalDisk = () => {
  const supportEl = document.getElementById('local-disk-support');
  const connect = document.getElementById('btn-connect-disk');
  const listEl = document.getElementById('local-snapshots');

  if (!LocalDiskBackend.isSupported()) {
    supportEl.innerHTML = `<span class="text-status-out">${t('settings.local_disk.unsupported')}</span>`;
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
      refreshStorageModeBadge();
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
      refreshStorageModeBadge();
    } catch (err) {
      setInlineError('drive-error', t('settings.drive.error.connect_failed', { err: err.message }));
    }
  });

  document.getElementById('btn-signout-drive').addEventListener('click', async () => {
    await googleDrive.signOut();
    // Respect the BYOK "clear on signout" preference — some users treat the
    // Drive session as their trust anchor for whether personal creds should
    // persist on this machine.
    const cfg = await getByokLLMConfig();
    if (cfg?.clearOnSignOut) {
      await clearByokLLMConfig();
      const apiKey = document.getElementById('llm-api-key');
      if (apiKey) apiKey.value = '';
      await refreshByokLLMStatus();
    }
    listEl.innerHTML = '';
    toast(t('settings.drive.toast.disconnected'), 'info');
    refreshDrive();
    refreshStorageModeBadge();
  });

  document.getElementById('btn-list-drive').addEventListener('click', toggleSnapshotList(googleDrive, listEl));
};

const wireSnapshotActions = () => {
  document.getElementById('btn-sync').addEventListener('click', async () => {
    setInlineError('sync-error', '');
    const btn = document.getElementById('btn-sync');
    const status = document.getElementById('sync-status');
    const labelInput = document.getElementById('sync-label');
    const active = availableBackends();
    if (!active.length) {
      setInlineError('sync-error', t('settings.sync.error.no_backends'));
      return;
    }
    const requestedLabel = sanitizeSnapshotLabel(labelInput.value);
    const currentLabel = await getActiveSyncLabel();
    if (requestedLabel !== currentLabel && await hasUnsyncedLocalChanges()) {
      const from = currentLabel || t('settings.sync.label.default');
      const to = requestedLabel || t('settings.sync.label.default');
      if (!confirm(t('settings.sync.confirm.switch_lossy', { from, to }))) return;
    }
    btn.disabled = true;
    status.textContent = t('settings.sync.status.running');
    try {
      const result = await syncCurrentSnapshot({ label: requestedLabel });
      status.textContent = '';
      if (result.skipped === 'no_backends') {
        setInlineError('sync-error', t('settings.sync.error.no_backends'));
        return;
      }
      if (result.skipped === 'divergence') {
        await refreshDivergenceBanner();
        toast(t('settings.divergence.toast.detected'), 'warning');
        return;
      }
      labelInput.value = requestedLabel;
      await setCurrentSnapshotName(result.filename);
      refreshSyncLast();
      const { winner, errors, updated } = finalizeSyncResult(result);
      if (errors.length === 0) {
        toast(t('settings.sync.toast.done', {
          file: result.filename, winner,
          targets: updated.join(', ') || t('settings.sync.targets.none'),
        }), 'ok');
      } else {
        const msg = errors.map(e => `${e.backend}: ${e.error}`).join('; ');
        toast(t('settings.sync.toast.partial', { winner, msg }), 'info');
      }
    } catch (err) {
      setInlineError('sync-error', t('settings.sync.error.failed', { err: err.message }));
      status.textContent = '';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-reconcile-attachments').addEventListener('click', async () => {
    setInlineError('reconcile-error', '');
    const btn = document.getElementById('btn-reconcile-attachments');
    const status = document.getElementById('reconcile-status');
    btn.disabled = true;
    status.textContent = t('settings.reconcile.status.running');
    try {
      const result = await reconcileAttachments({
        onProgress: ({ done, total }) => {
          status.textContent = t('settings.reconcile.status.progress', { done, total });
        },
      });
      if (result.skipped === 'need_two_backends') {
        setInlineError('reconcile-error', t('settings.reconcile.error.need_two_backends'));
        status.textContent = '';
        return;
      }
      status.textContent = '';
      refreshReconcileLast();
      const { copied, inSync, missing, errors, total } = result;
      if (errors.length === 0 && missing.length === 0) {
        toast(t('settings.reconcile.toast.done', { copied, inSync, total }), 'ok');
      } else {
        const details = [
          ...missing.map(m => t('settings.reconcile.detail.missing', {
            path: `${m.folder}/${m.filename}`,
          })),
          ...errors.map(e => t('settings.reconcile.detail.error', {
            path: `${e.folder}/${e.filename}`,
            stage: e.stage,
            error: e.error || `${e.expected || ''} ≠ ${e.got || ''}`,
          })),
        ];
        const action = missing.length > 0 ? {
          label: t('settings.reconcile.action.prune_missing', { n: missing.length }),
          onClick: async ({ dismiss }) => {
            if (!confirm(t('settings.reconcile.confirm.prune_missing', { n: missing.length }))) return;
            let deleted = 0;
            const failures = [];
            for (const m of missing) {
              try { await deleteAttachment(m.id); deleted++; }
              catch (err) { failures.push(`${m.folder}/${m.filename}: ${err.message}`); }
            }
            dismiss();
            if (failures.length === 0) {
              toast(t('settings.reconcile.toast.pruned', { n: deleted }), 'ok');
            } else {
              toast(t('settings.reconcile.toast.pruned_partial', { n: deleted, failed: failures.length }), 'info', { details: failures });
            }
          },
        } : undefined;
        toast(t('settings.reconcile.toast.partial', {
          copied, inSync, missing: missing.length, errors: errors.length, total,
        }), 'info', { details, action });
      }
    } catch (err) {
      setInlineError('reconcile-error', t('settings.reconcile.error.failed', { err: err.message }));
      status.textContent = '';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-load-sample').addEventListener('click', async () => {
    if (!confirm(t('settings.danger.confirm.load_sample'))) return;
    setInlineError('danger-error', '');
    try {
      const resp = await fetch(`${STATIC_ROOT}samples/sample.sqlite`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      await importDb(bytes);
      // Sample dataset overwrites the DB, so the tracked snapshot name no longer matches disk.
      await clearCurrentSnapshotName();
      // Clear localModifiedAt so any real backend copy beats the demo data on
      // the next sync (sample-load is throw-away state, not new truth).
      await clearLocalModifiedAt();
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
    setInlineError('sync-error', '');
    try {
      const { bytes } = await exportDb();
      const label = sanitizeSnapshotLabel(document.getElementById('sync-label').value);
      const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = snapshotFilename(new Date(), label);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(t('settings.sync.toast.downloaded', { size: kb(bytes.byteLength) }), 'ok');
    } catch (err) {
      setInlineError('sync-error', t('settings.sync.error.download_failed', { err: err.message }));
    }
  });
};

// Divergence banner — shown when both local and a backend have edits since
// the last sync. User picks a side via Keep-local / Keep-remote.
const refreshDivergenceBanner = async () => {
  const el = document.getElementById('divergence-banner');
  if (!el) return;
  const state = await getDivergenceState();
  if (!state) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const localAge = relativeAge(new Date(state.localAtMs).toISOString());
  const backendAge = relativeAge(new Date(state.backendMtime).toISOString());
  el.classList.remove('hidden');
  el.innerHTML = `
    <section class="${CLS.warningBanner} space-y-3">
      <div class="space-y-1">
        <p class="font-semibold">${escapeHtml(t('settings.divergence.title'))}</p>
        <p class="${CLS.bodyText}">${escapeHtml(t('settings.divergence.help'))}</p>
      </div>
      <ul class="${CLS.bodyText} space-y-1">
        <li>${escapeHtml(t('settings.divergence.local_side', { age: localAge }))}</li>
        <li>${escapeHtml(t('settings.divergence.remote_side', { backend: state.backendName, age: backendAge }))}</li>
        <li>${escapeHtml(t('settings.divergence.backup_saved', { name: state.preSyncSnapshotName }))}</li>
      </ul>
      <div class="${CLS.formRow}">
        ${button({ id: 'btn-divergence-keep-local', variant: 'primaryCompact', label: t('settings.divergence.action.keep_local') })}
        ${button({ id: 'btn-divergence-keep-remote', variant: 'secondaryCompact', label: t('settings.divergence.action.keep_remote', { backend: state.backendName }) })}
      </div>
    </section>
  `;
  document.getElementById('btn-divergence-keep-local').addEventListener('click', () => onResolve('local'));
  document.getElementById('btn-divergence-keep-remote').addEventListener('click', () => onResolve('backend'));
};

const onResolve = async (choice) => {
  const confirmMsg = choice === 'local'
    ? t('settings.divergence.confirm.keep_local')
    : t('settings.divergence.confirm.keep_remote');
  if (!confirm(confirmMsg)) return;
  try {
    const result = await resolveDivergence(choice);
    await refreshDivergenceBanner();
    refreshSyncLast();
    if (result?.skipped === 'no_backends') {
      toast(t('settings.sync.error.no_backends'), 'warning');
      return;
    }
    // finalizeSyncResult refreshes the badge and reloads if a backend replaced
    // local — which is what Keep-remote does. Keep-local pushes, no reload.
    finalizeSyncResult(result);
    toast(t('settings.divergence.toast.resolved', { choice }), 'ok');
  } catch (err) {
    toast(t('settings.divergence.toast.resolve_failed', { err: err.message }), 'error');
  }
};

// Refresh the "Last synced Xm ago" line under the Sync button. Called on
// mount and after every successful sync.
const refreshSyncLast = async () => {
  const el = document.getElementById('sync-last');
  if (!el) return;
  const at = await getLastSyncedAt();
  el.textContent = at
    ? t('settings.sync.last_synced', { age: relativeAge(new Date(at).toISOString()) })
    : t('settings.sync.last_synced.never');
};

const refreshReconcileLast = async () => {
  const el = document.getElementById('reconcile-last');
  if (!el) return;
  const at = await getLastAttachmentReconcileAt();
  el.textContent = at
    ? t('settings.reconcile.last_run', { age: relativeAge(new Date(at).toISOString()) })
    : t('settings.reconcile.last_run.never');
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
  await wireByokLLM();
  await wireByokScraper();
  await wireByokSearch();
  wireLocalDisk();
  wireDrive();
  wireSnapshotActions();

  // Pre-fill so the user sees which timeline they're on.
  const syncLabelInput = document.getElementById('sync-label');
  if (syncLabelInput) {
    getActiveSyncLabel().then(label => { syncLabelInput.value = label || ''; });
  }
  refreshSyncLast();
  refreshReconcileLast();
  refreshDivergenceBanner();

  const autosyncToggle = document.getElementById('autosync-toggle');
  if (autosyncToggle) {
    isAutosyncEnabled().then(on => { autosyncToggle.checked = on; });
    autosyncToggle.addEventListener('change', (e) => setAutosyncEnabled(e.target.checked));
  }
  window.addEventListener('divergence-detected', refreshDivergenceBanner);
  window.addEventListener('divergence-resolved', refreshDivergenceBanner);

  // Cross-page nav to #anchor: the browser scrolled before render() ran, so
  // re-scroll now that the section exists.
  if (window.location.hash) {
    const target = document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView({ block: 'start' });
  }

  // Backends were already restored in main.mjs during boot — just paint status.
  refreshLocalDisk();
  refreshDrive();
  await refreshByokLLMStatus();

  window.addEventListener('online', refreshDrive);
  window.addEventListener('offline', refreshDrive);
};
