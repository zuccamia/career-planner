import { expect, test, type Page } from './fixtures';

// Header quick-sync button. Covers the parts that don't require a real backend
// (which would need a picker or OAuth): the button renders on every page, the
// label reflects the active sync file, and clicking with no backends warns.

const waitForBoot = async (page: Page) => {
  // Every page waits for its own "ready" signal; here we just want boot
  // artifacts on any page. The header button is server-rendered so it's
  // present immediately; we wait for the label span to become non-hidden,
  // which means mountQuickSync (boot-time) has run.
  await expect(page.locator('#quick-sync-label')).toBeVisible({ timeout: 30_000 });
};

test.describe('quick sync header button', () => {
  test('renders on the dashboard with the default label', async ({ page }) => {
    await page.goto('/dashboard');
    await waitForBoot(page);

    await expect(page.locator('#quick-sync')).toBeVisible();
    await expect(page.locator('#quick-sync-label')).toHaveText('current.sqlite');
    await expect(page.locator('#quick-sync-label')).toHaveAttribute('title', 'current.sqlite');
    await expect(page.locator('#quick-sync-label')).toHaveAttribute('href', /settings#sync-panel/);
  });

  test('renders on every page (settings, applications, companies)', async ({ page }) => {
    for (const path of ['/settings', '/applications', '/companies']) {
      await page.goto(path);
      await waitForBoot(page);
      await expect(page.locator('#quick-sync')).toBeVisible();
    }
  });

  test('shows a truncated filename when the active label is long', async ({ page }) => {
    await page.goto('/dashboard');
    await waitForBoot(page);

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
        tx.objectStore('kv').put('summer2026', 'activeSyncLabel');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
    await page.reload();
    await waitForBoot(page);

    // "summer2026.sqlite" (17 chars) truncated at max=14 → "summer….sqlite".
    await expect(page.locator('#quick-sync-label')).toHaveText('summer….sqlite');
    // Full filename preserved in title attr for hover.
    await expect(page.locator('#quick-sync-label')).toHaveAttribute('title', 'summer2026.sqlite');
  });

  test('clicking with no backends surfaces a warning toast', async ({ page }) => {
    await page.goto('/settings');
    // Wait for Settings' own toast mount to render (dashboard doesn't have one).
    await expect(page.getByText('Sync current snapshot')).toBeVisible({ timeout: 30_000 });
    await waitForBoot(page);

    await page.locator('#quick-sync').click();
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toContainText(/Connect a storage first/);
  });

  test('label anchor navigates to Settings#sync-panel', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/dashboard');
    await waitForBoot(page);

    await page.locator('#quick-sync-label').click();
    await expect(page).toHaveURL(/\/settings#sync-panel$/);
    const sync = page.getByText('Sync current snapshot');
    const bootError = page.getByText('App already open in another tab');
    await expect(sync.or(bootError)).toBeVisible({ timeout: 60_000 });
    if (await bootError.isVisible()) await page.reload();
    await expect(sync).toBeVisible({ timeout: 30_000 });
  });
});
