import { expect, test, type Page } from './fixtures';

// Settings covers backend connect/disconnect + sync. Real backend connects need
// user gestures (showDirectoryPicker, OAuth popup) that Playwright can't drive,
// so these exercise the parts that don't require a picker: initial render, the
// "no backends" error path, and download.

const gotoSettings = async (page: Page) => {
  await page.goto('/settings');
  await expect(page.getByText('Sync current snapshot')).toBeVisible({ timeout: 30_000 });
};

test.describe('local settings page', () => {
  test('renders both backends as not connected and shows sync controls', async ({ page }) => {
    await gotoSettings(page);

    await expect(page.getByText('Local disk', { exact: true })).toBeVisible();
    await expect(page.getByText('Google Drive', { exact: true })).toBeVisible();

    const notConnected = page.locator('.inline-flex', { hasText: 'not connected' });
    await expect(notConnected).toHaveCount(2);

    await expect(page.getByRole('button', { name: 'Sync', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Download .sqlite' })).toBeEnabled();

    await expect(page.getByRole('button', { name: 'Forget folder' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Sign out of Google Drive' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'List snapshots' }).first()).toBeDisabled();
  });

  test('sync with no backend surfaces an inline error in the sync section', async ({ page }) => {
    await gotoSettings(page);

    await page.getByRole('button', { name: 'Sync', exact: true }).click();
    await expect(page.locator('#sync-error')).toBeVisible();
    await expect(page.locator('#sync-error')).toContainText(/No backends available/);
  });

  test('sync label input is pre-filled from IDB', async ({ page }) => {
    await page.goto('/settings');
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
        tx.objectStore('kv').put('spring-2026', 'activeSyncLabel');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
    await page.reload();
    await expect(page.getByText('Sync current snapshot')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#sync-label')).toHaveValue('spring-2026');
  });

  test('download snapshot produces a .sqlite file', async ({ page }) => {
    await gotoSettings(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .sqlite' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.sqlite$/);
    await expect(page.locator('#toast')).toContainText(/Downloaded snapshot/);
  });

  test('sidebar navigation reaches settings from companies', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/companies');
    await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 60_000 });
    const navToggle = page.getByRole('button', { name: 'Open navigation' });
    await navToggle.click();
    await expect(navToggle).toHaveAttribute('aria-expanded', 'true');
    const settingsLink = page.getByRole('link', { name: 'Settings' });
    await expect(settingsLink).toBeVisible();
    await settingsLink.click();
    await expect(page).toHaveURL('/settings');
    const sync = page.getByText('Sync current snapshot');
    const bootError = page.getByText('App already open in another tab');
    await expect(sync.or(bootError)).toBeVisible({ timeout: 60_000 });
    if (await bootError.isVisible()) await page.reload();
    await expect(sync).toBeVisible({ timeout: 30_000 });
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

    await page.locator('#sync-label').fill('Spring 2026!');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .sqlite' }).click();
    const download = await downloadPromise;

    // "Spring 2026!" → "spring-2026" (lowercase, non-alnum → '-', trimmed).
    expect(download.suggestedFilename()).toMatch(/^snapshot-\d{8}-\d{6}__spring-2026\.sqlite$/);
  });

  test('current-snapshot sidebar badge is hidden until a snapshot is known', async ({ page }) => {
    await gotoSettings(page);
    await expect(page.locator('#current-snapshot')).toBeHidden();
  });

  test('current-snapshot badge renders formatted name when IDB has one', async ({ page }) => {
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
        tx.objectStore('kv').put('snapshot-20260725-133045__spring-2026.sqlite', 'currentSnapshotName');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
    await page.reload();
    await expect(page.getByText('Sync current snapshot')).toBeVisible({ timeout: 30_000 });

    const badge = page.locator('#current-snapshot');
    await expect(badge).toBeVisible();
    await expect(page.locator('#current-snapshot-name')).toHaveText('spring-2026 · 2026-07-25');
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
    await expect(page.getByText('Sync current snapshot')).toBeVisible({ timeout: 30_000 });

    await expect(page.locator('#current-snapshot-name')).toHaveText('2020-03-15 09:45');
  });

  // Regression for "Wipe failed: deleteDatabase blocked — close other tabs"
  // reported with no other tabs open. Root cause: idb.mjs helpers used to open
  // the meta DB and never call db.close(), so this tab's own live connection
  // made indexedDB.deleteDatabase fire onblocked.
  test('idbWipe succeeds after idbSet without hitting onblocked', async ({ page }) => {
    await gotoSettings(page);

    const result = await page.evaluate(async () => {
      const { idbSet, idbGet, idbWipe } = await import('/static/js/storage/idb.mjs');
      await idbSet('regression-key', 'regression-value');
      const readBack = await idbGet('regression-key');

      const wipe = idbWipe();
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('idbWipe timed out (likely blocked by open connection)')), 3000),
      );
      await Promise.race([wipe, timeout]);
      return { readBack };
    });

    expect(result.readBack).toBe('regression-value');
  });

  // Regression for "idbWipe rejected on onblocked before the versionchange
  // handlers could close the pending connections."
  test('idbWipe survives onblocked when a stale connection is open', async ({ page }) => {
    await gotoSettings(page);

    const result = await page.evaluate(async () => {
      const { idbSet, idbWipe } = await import('/static/js/storage/idb.mjs');
      await idbSet('regression-key', 'regression-value');

      const openReq = indexedDB.open('career-planner-meta', 1);
      const openDb: IDBDatabase = await new Promise((resolve, reject) => {
        openReq.onsuccess = () => resolve(openReq.result);
        openReq.onerror = () => reject(openReq.error);
      });
      openDb.onversionchange = () => openDb.close();

      const wipe = idbWipe();
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('idbWipe timed out (blocked forever)')), 3000),
      );
      await Promise.race([wipe, timeout]);
      return { ok: true };
    });

    expect(result.ok).toBe(true);
  });
});
