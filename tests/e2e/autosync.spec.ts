import { expect, test, type Page } from './fixtures';

// Autosync fires the sync flow on a debounce after a DB write. Real backend
// connects need a picker/OAuth, so we install a fake local-disk backend and
// count writeBlob calls to the sync file to confirm the trigger fired.

// Shrink the debounce in tests via the override read by autosync.mjs.
const DEBOUNCE_MS = 200;
const setFastDebounce = (page: Page) =>
  page.addInitScript((ms) => { (window as any).__autosyncDebounceMs = ms; }, DEBOUNCE_MS);

const gotoSettings = async (page: Page) => {
  await setFastDebounce(page);
  await page.goto('/settings');
  await expect(page.getByText('Sync current snapshot')).toBeVisible({ timeout: 30_000 });
};

// Install a fake local-disk backend that records how many times the sync file
// (current.sqlite or a labeled variant) was written. Returns nothing; readback
// happens via window.__syncWrites.
const installFakeSyncBackend = async (page: Page) => {
  await page.evaluate(async () => {
    const mod = await import('/static/js/storage/index.mjs');
    // @ts-expect-error — expose counter for cross-boundary reads
    window.__syncWrites = [];
    const disk = mod.localDisk;
    disk.isReady = () => true;
    disk.isAvailable = () => true;
    disk.hasBlob = async () => false;
    disk.readBlob = async () => { throw new Error('no readBlob in this stub'); };
    disk.statBlob = async () => null;
    disk.deleteBlob = async () => {};
    disk.writeBlob = async (key: string) => {
      // Only count sync-file writes (root, ends in .sqlite), skip attachments/*.
      if (!key.includes('/') && key.endsWith('.sqlite')) {
        // @ts-expect-error
        window.__syncWrites.push(key);
      }
      return { modifiedAt: new Date(), sizeBytes: 0 };
    };
  });
};

const readSyncWrites = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    // @ts-expect-error — populated by installFakeSyncBackend
    return Array.from(window.__syncWrites) as string[];
  });

// Fire a mutation that goes through db/client.exec, so the CustomEvent trigger
// runs. Uses idbSet on an unrelated key would NOT work — must be a SQL write.
const mutateDb = async (page: Page) => {
  await page.evaluate(async () => {
    const { exec } = await import('/static/js/db/client.mjs');
    await exec('INSERT INTO companies (official_name) VALUES (?)', ['Autosync Test Co']);
  });
};

test.describe('autosync', () => {
  test('toggle exists and defaults to enabled', async ({ page }) => {
    await gotoSettings(page);
    const toggle = page.locator('#autosync-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
  });

  test('toggling off persists to IDB', async ({ page }) => {
    await gotoSettings(page);
    await page.locator('#autosync-toggle').uncheck();
    const stored = await page.evaluate(async () => {
      const { idbGet } = await import('/static/js/storage/idb.mjs');
      return idbGet('autosyncEnabled');
    });
    expect(stored).toBe(false);
  });

  test('DB write triggers a sync after debounce', async ({ page }) => {
    await gotoSettings(page);
    await installFakeSyncBackend(page);
    expect(await readSyncWrites(page)).toEqual([]);

    await mutateDb(page);
    // Autosync debounces ~5s; give it a generous margin.
    await page.waitForTimeout(DEBOUNCE_MS + 500);

    const writes = await readSyncWrites(page);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toMatch(/\.sqlite$/);
  });

  test('autosync is skipped when disabled', async ({ page }) => {
    await gotoSettings(page);
    await installFakeSyncBackend(page);
    await page.locator('#autosync-toggle').uncheck();

    await mutateDb(page);
    await page.waitForTimeout(DEBOUNCE_MS + 500);

    expect(await readSyncWrites(page)).toEqual([]);
  });

  test('autosync is skipped when divergence is recorded', async ({ page }) => {
    await gotoSettings(page);
    await installFakeSyncBackend(page);

    // Pre-record a divergenceState in IDB so shouldSkip() sees it.
    await page.evaluate(async () => {
      const { idbSet } = await import('/static/js/storage/idb.mjs');
      await idbSet('divergenceState', {
        detectedAt: Date.now(), localAtMs: 1, backendMtime: 2,
        backendName: 'local-disk', filename: 'current.sqlite',
        label: '', preSyncSnapshotName: 'pre-sync-x.sqlite', preSyncSavedTo: [],
      });
    });

    await mutateDb(page);
    await page.waitForTimeout(DEBOUNCE_MS + 500);

    expect(await readSyncWrites(page)).toEqual([]);
  });
});
