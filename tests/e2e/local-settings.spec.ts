import { expect, test, type Page } from '@playwright/test';

// Settings covers backend connect/disconnect + manual snapshots. Real backend
// connects need user gestures (showDirectoryPicker for local disk, popup OAuth
// for Google Drive) that Playwright can't drive in headless mode. These tests
// exercise the parts that don't require a picker: initial render, download
// snapshot, and the "no backends connected" error path.

const gotoSettings = async (page: Page) => {
  await page.goto('/local/settings');
  // The Snapshot Now section is the last thing rendered by mountSettings.
  await expect(page.getByText('Snapshot now')).toBeVisible({ timeout: 30_000 });
};

test.describe('local settings page', () => {
  test('renders both backends as not connected and shows snapshot controls', async ({ page }) => {
    await gotoSettings(page);

    await expect(page.getByText('Local disk', { exact: true })).toBeVisible();
    await expect(page.getByText('Google Drive', { exact: true })).toBeVisible();

    // Both status pills read "not connected" until the user wires a backend.
    const notConnected = page.locator('.inline-flex', { hasText: 'not connected' });
    await expect(notConnected).toHaveCount(2);

    // Snapshot Now controls exist and are enabled.
    await expect(page.getByRole('button', { name: 'Snapshot all' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Download .sqlite' })).toBeEnabled();

    // Disconnect controls start disabled — nothing to disconnect yet.
    await expect(page.getByRole('button', { name: 'Forget folder' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Sign out of Google Drive' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'List snapshots' }).first()).toBeDisabled();
  });

  test('snapshot-all with no backend connected surfaces an inline error in the snapshot section', async ({ page }) => {
    await gotoSettings(page);

    await page.getByRole('button', { name: 'Snapshot all' }).click();
    await expect(page.locator('#snapshot-error')).toBeVisible();
    await expect(page.locator('#snapshot-error')).toContainText(/No backends available/);
  });

  test('download snapshot produces a .sqlite file', async ({ page }) => {
    await gotoSettings(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .sqlite' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.sqlite$/);
    await expect(page.locator('#toast')).toContainText(/Downloaded snapshot/);
  });

  test('keep-count input accepts numeric values', async ({ page }) => {
    await gotoSettings(page);
    const keep = page.locator('#keep-count');
    await expect(keep).toHaveValue('5');
    await keep.fill('3');
    await expect(keep).toHaveValue('3');
  });

  test('sidebar navigation reaches settings from companies', async ({ page }) => {
    await page.goto('/local/companies');
    await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 30_000 });
    // Sidebar is an off-canvas drawer — open it, wait for the toggle to
    // report expanded (so the click landing on Settings isn't racing the
    // slide-in animation), then navigate.
    const navToggle = page.getByRole('button', { name: 'Open navigation' });
    await navToggle.click();
    await expect(navToggle).toHaveAttribute('aria-expanded', 'true');
    const settingsLink = page.getByRole('link', { name: 'Settings' });
    await expect(settingsLink).toBeVisible();
    await settingsLink.click();
    await expect(page).toHaveURL('/local/settings');
    // Cross-page navigations can hit a SAH Pool race where the new page's
    // DB worker tries to open before the previous page has fully released
    // its handle. If we see the "App already open" boot-failure banner,
    // reload once to force a clean boot.
    const snapshot = page.getByText('Snapshot now');
    const bootError = page.getByText('App already open in another tab');
    await expect(snapshot.or(bootError)).toBeVisible({ timeout: 30_000 });
    if (await bootError.isVisible()) await page.reload();
    await expect(snapshot).toBeVisible({ timeout: 30_000 });
  });

  test('download without label produces auto-format filename', async ({ page }) => {
    await gotoSettings(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .sqlite' }).click();
    const download = await downloadPromise;

    // snapshot-YYYYMMDD-HHMMSS.sqlite — no label separator.
    expect(download.suggestedFilename()).toMatch(/^snapshot-\d{8}-\d{6}\.sqlite$/);
  });

  test('download with a label embeds sanitized label in filename', async ({ page }) => {
    await gotoSettings(page);

    await page.locator('#snapshot-label').fill('Spring 2026!');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .sqlite' }).click();
    const download = await downloadPromise;

    // "Spring 2026!" → "spring-2026" (lowercase, non-alnum → '-', trimmed).
    expect(download.suggestedFilename()).toMatch(/^snapshot-\d{8}-\d{6}__spring-2026\.sqlite$/);
  });

  test('current-snapshot sidebar badge is hidden until a snapshot is known', async ({ page }) => {
    await gotoSettings(page);
    // Fresh browser context — no restore has happened.
    await expect(page.locator('#current-snapshot')).toBeHidden();
  });

  test('current-snapshot badge renders formatted name when IDB has one', async ({ page }) => {
    await gotoSettings(page);

    // Simulate a prior restore/labeled-save by writing the IDB key directly,
    // then reload so main.mjs picks it up on boot.
    await page.evaluate(async () => {
      const openMeta = () => new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('career-planner-meta', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const db = await openMeta();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put('snapshot-20260725-133045__spring-2026.sqlite', 'currentSnapshotName');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
    await page.reload();
    await expect(page.getByText('Snapshot now')).toBeVisible({ timeout: 30_000 });

    const badge = page.locator('#current-snapshot');
    await expect(badge).toBeVisible();
    await expect(page.locator('#current-snapshot-name')).toHaveText('spring-2026 · 2026-07-25');
    // Raw filename kept in title attr for hover disambiguation.
    await expect(page.locator('#current-snapshot-name'))
      .toHaveAttribute('title', 'snapshot-20260725-133045__spring-2026.sqlite');
  });

  test('current-snapshot badge formats an auto (unlabeled) snapshot as date+time', async ({ page }) => {
    await gotoSettings(page);

    await page.evaluate(async () => {
      const openMeta = () => new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('career-planner-meta', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const db = await openMeta();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put('snapshot-20200315-094500.sqlite', 'currentSnapshotName');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
    await page.reload();
    await expect(page.getByText('Snapshot now')).toBeVisible({ timeout: 30_000 });

    await expect(page.locator('#current-snapshot-name')).toHaveText('2020-03-15 09:45');
  });

  // Regression for "Wipe failed: deleteDatabase blocked — close other tabs"
  // reported with no other tabs open. Root cause: idb.mjs helpers used to open
  // the meta DB and never call db.close(), so this tab's own live connection
  // made indexedDB.deleteDatabase fire onblocked. Helpers now close after each
  // call; this test exercises the sequence end-to-end via page.evaluate.
  test('idbWipe succeeds after idbSet without hitting onblocked', async ({ page }) => {
    await gotoSettings(page);

    const result = await page.evaluate(async () => {
      const { idbSet, idbGet, idbWipe } = await import('/static/local/js/storage/idb.mjs');
      await idbSet('regression-key', 'regression-value');
      const readBack = await idbGet('regression-key');

      // Guard the wipe with a timeout so a pre-fix regression (which would
      // hang indefinitely if onblocked never fires) fails fast.
      const wipe = idbWipe();
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('idbWipe timed out (likely blocked by open connection)')), 3000),
      );
      await Promise.race([wipe, timeout]);
      return { readBack };
    });

    expect(result.readBack).toBe('regression-value');
  });
});
