// App entrypoint. Boots DB and dispatches to the current page module.
// Page identity comes from the data-page attribute on <main id="app">.

import { initDb } from './db/client.mjs';
import { ensureSchema } from './db/schema.mjs';
import { hydrateIcons } from './ui/icons.mjs';
import { initDrawer } from './ui/drawer.mjs';
import { initI18n, t } from './i18n.mjs';
import { mountSettings } from './pages/settings.mjs';
import { mountApplications } from './pages/applications.mjs';
import { mountDashboard } from './pages/dashboard.mjs';
import { mountCompanies } from './pages/companies.mjs';
import { mountPeople } from './pages/people.mjs';
import { mountProfile } from './pages/profile.mjs';
import { refreshSidebarCounts } from './ui/sidebar_counts.mjs';
import { refreshCurrentSnapshotBadge } from './ui/current_snapshot.mjs';
import { refreshAiModeBadge } from './ui/ai_mode_badge.mjs';
import { refreshScraperModeBadge } from './ui/scraper_mode_badge.mjs';
import { refreshSearchModeBadge } from './ui/search_mode_badge.mjs';
import { refreshStorageModeBadge } from './ui/storage_mode_badge.mjs';
import { mountHeaderCTA } from './ui/header_cta.mjs';
import { restoreAll } from './storage/index.mjs';

// Any promise rejection that escapes the app's own catch blocks lands here.
// Local-first means there's no server log, so at least the browser console
// gets a labeled stack — enough for a user bug report and for devs correlating
// the console trace to whatever cryptic English toast the entity layer surfaced.
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[local] unhandled rejection:', ev.reason);
});
window.addEventListener('error', (ev) => {
  console.error('[local] uncaught error:', ev.error || ev.message);
});

// Swap server-rendered [data-icon] placeholders (sidebar, quick-start buttons)
// with SVGs from ui/icons.mjs. Runs immediately so the sidebar renders before
// the DB boot completes.
hydrateIcons();
initDrawer();

const appEl = document.getElementById('app');

const renderStatus = (msg, cls = '') => {
  appEl.innerHTML = `<p class="text-sm ${cls}">${msg}</p>`;
};

const boot = async () => {
  try {
    // Load locale bundles before any page mounts so t() is usable in every
    // page module. The server-rendered shell is already localized via cookie;
    // this initializes the client mirror so subsequent t() calls agree.
    await initI18n();
    renderStatus(t('app.loading'), 'text-ink-faint');
    const info = await initDb();
    console.log('[local] sqlite ready', info);
    await ensureSchema();
    console.log('[local] schema ensured');

    // Rehydrate storage backend module singletons from IndexedDB. Without this,
    // pages other than Settings see backends as disconnected on every page load
    // (each navigation is a fresh JS context — the singletons boot in their
    // default un-restored state). Awaited so the page mounts with backends
    // already available; tryRestore reads IDB (fast) and, for local disk,
    // queryPermission (also fast when the permission is still granted).
    await restoreAll();

    // Populate sidebar entity counts + top-of-page badges + CTA. All fire in
    // parallel — none blocks page mount. Each failure gets a labeled console
    // warning, never propagates.
    const safeCall = (label, fn) => fn().catch(err => console.warn(`[local] ${label}`, err));
    safeCall('sidebar counts', refreshSidebarCounts);
    safeCall('current snapshot badge', refreshCurrentSnapshotBadge);
    safeCall('storage mode badge', refreshStorageModeBadge);
    safeCall('ai mode badge', refreshAiModeBadge);
    safeCall('scraper mode badge', refreshScraperModeBadge);
    safeCall('search mode badge', refreshSearchModeBadge);
    safeCall('header cta', mountHeaderCTA);

    const page = appEl.dataset.page;
    if (page === 'dashboard') {
      await mountDashboard(appEl);
    } else if (page === 'applications') {
      await mountApplications(appEl);
    } else if (page === 'companies') {
      await mountCompanies(appEl);
    } else if (page === 'people') {
      await mountPeople(appEl);
    } else if (page === 'profile') {
      await mountProfile(appEl);
    } else if (page === 'settings') {
      await mountSettings(appEl);
    } else {
      renderStatus(`Unknown page: ${page}`, 'text-status-out');
    }
  } catch (err) {
    console.error('[local] boot failed', err);
    const msg = err.message || String(err);
    if (msg.includes('Access Handles cannot be created') || msg.includes('another open Access Handle')) {
      appEl.innerHTML = `
        <section class="rounded-md border border-brass/30 bg-brass-tint p-6 text-brass">
          <h1 class="text-lg font-semibold">App already open in another tab</h1>
          <p class="mt-2 text-sm">The local database can only be opened by one tab at a time (SQLite SAH Pool limitation).
             Close any other tabs of this app and reload.</p>
          <p class="mt-3 text-xs opacity-80">Details: ${msg}</p>
        </section>`;
    } else {
      renderStatus(`Failed to initialize: ${msg}`, 'text-status-out');
    }
  }
};

boot();
