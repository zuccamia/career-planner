// Local-first app entrypoint. Boots DB and dispatches to the current page module.
// Page identity comes from the data-page attribute on <main id="app">.

import { initDb } from './db/client.mjs';
import { ensureSchema } from './db/schema.mjs';
import { hydrateIcons } from './ui/icons.mjs';
import { mountSettings } from './pages/settings.mjs';
import { mountApplications } from './pages/applications.mjs';
import { mountDashboard } from './pages/dashboard.mjs';
import { mountCompanies } from './pages/companies.mjs';
import { mountPeople } from './pages/people.mjs';
import { refreshSidebarCounts } from './ui/sidebar_counts.mjs';
import { refreshCurrentSnapshotBadge } from './ui/current_snapshot.mjs';
import { restoreAll } from './storage/index.mjs';

// Swap server-rendered [data-icon] placeholders (sidebar, quick-start buttons)
// with SVGs from ui/icons.mjs. Runs immediately so the sidebar renders before
// the DB boot completes.
hydrateIcons();

const appEl = document.getElementById('app');

const renderStatus = (msg, cls = '') => {
  appEl.innerHTML = `<p class="text-sm ${cls}">${msg}</p>`;
};

const boot = async () => {
  try {
    renderStatus('Initializing local database…', 'text-slate-500');
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

    // Populate sidebar entity counts. Page mounts also call this after
    // create/delete via the shared helper.
    refreshSidebarCounts().catch(err => console.warn('[local] sidebar counts', err));
    refreshCurrentSnapshotBadge();

    const page = appEl.dataset.page;
    if (page === 'dashboard') {
      await mountDashboard(appEl);
    } else if (page === 'applications') {
      await mountApplications(appEl);
    } else if (page === 'companies') {
      await mountCompanies(appEl);
    } else if (page === 'people') {
      await mountPeople(appEl);
    } else if (page === 'settings') {
      await mountSettings(appEl);
    } else {
      renderStatus(`Unknown page: ${page}`, 'text-rose-600');
    }
  } catch (err) {
    console.error('[local] boot failed', err);
    const msg = err.message || String(err);
    if (msg.includes('Access Handles cannot be created') || msg.includes('another open Access Handle')) {
      appEl.innerHTML = `
        <section class="rounded-md border border-amber-300 bg-amber-50 p-6 text-amber-900">
          <h1 class="text-lg font-semibold">App already open in another tab</h1>
          <p class="mt-2 text-sm">The local database can only be opened by one tab at a time (SQLite SAH Pool limitation).
             Close any other tabs of this app and reload.</p>
          <p class="mt-3 text-xs text-amber-800/70">Details: ${msg}</p>
        </section>`;
    } else {
      renderStatus(`Failed to initialize: ${msg}`, 'text-rose-600');
    }
  }
};

boot();
