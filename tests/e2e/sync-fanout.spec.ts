import { expect, test, type Page } from './fixtures';

// Two backends with distinct snapshots. When sync runs with forceWinner='backend'
// the winning bytes are imported locally, then fanned out to the other backend.
// This test catches the "empty buffer on the second write" regression that would
// happen if importDb transferred (rather than cloned) the bytes.

const gotoSettings = async (page: Page) => {
  await page.goto('/settings');
  await expect(page.getByText('Sync current snapshot')).toBeVisible({ timeout: 30_000 });
};

const installTwoBackends = async (page: Page, winningBytesArr: number[]) => {
  await page.evaluate(async (bytesArr) => {
    const mod = await import('/static/js/storage/index.mjs');
    const winningBytes = new Uint8Array(bytesArr);
    const laterMtime = new Date();
    const earlierMtime = new Date(Date.now() - 60_000);

    // @ts-expect-error — cross-boundary capture for test assertions
    window.__writes = { googleDrive: [], localDisk: [] };

    // googleDrive: winner. Holds the newer blob, will not be written to.
    const drive = (mod as any).googleDrive;
    drive.isReady = () => true;
    drive.isAvailable = () => true;
    drive.name = 'google-drive';
    drive.hasBlob = async () => true;
    drive.statBlob = async () => ({ modifiedAt: laterMtime, sizeBytes: winningBytes.byteLength });
    drive.readBlob = async () => winningBytes.slice().buffer;
    drive.writeBlob = async (k: string, data: Uint8Array) => {
      // @ts-expect-error
      window.__writes.googleDrive.push({ key: k, sizeBytes: data.byteLength });
      return { modifiedAt: new Date(), sizeBytes: data.byteLength };
    };

    // localDisk: stale sink. Fan-out should overwrite its blob with winningBytes.
    const disk = (mod as any).localDisk;
    disk.isReady = () => true;
    disk.isAvailable = () => true;
    disk.name = 'local-disk';
    disk.hasBlob = async () => true;
    disk.statBlob = async () => ({ modifiedAt: earlierMtime, sizeBytes: 1 });
    disk.readBlob = async () => new Uint8Array([0]).buffer;
    disk.writeBlob = async (k: string, data: Uint8Array) => {
      // @ts-expect-error
      window.__writes.localDisk.push({ key: k, sizeBytes: data.byteLength });
      return { modifiedAt: new Date(), sizeBytes: data.byteLength };
    };
  }, winningBytesArr);
};

test('backend-wins fan-out writes the full byte payload to the other backend', async ({ page }) => {
  await gotoSettings(page);

  // Disable autosync so it can't fire against the stubbed backends after our
  // explicit syncCurrentSnapshot call — keeps teardown clean and deterministic.
  await page.evaluate(async () => {
    const { idbSet } = await import('/static/js/storage/idb.mjs');
    await idbSet('autosyncEnabled', false);
  });

  // Grab a valid SQLite blob from the live worker so importDb accepts it —
  // hand-rolled bytes would fail header validation and mask the fan-out check.
  const winningBytes = await page.evaluate(async () => {
    const { exportDb } = await import('/static/js/db/client.mjs');
    const { bytes } = await exportDb();
    return Array.from(bytes);
  });

  await installTwoBackends(page, winningBytes);

  const result = await page.evaluate(async () => {
    const { syncCurrentSnapshot } = await import('/static/js/storage/sync-current.mjs');
    return syncCurrentSnapshot({ forceWinner: 'backend' });
  });

  // Sanity: sync completed without falling back or skipping.
  expect((result as any).skipped).toBeUndefined();

  const writes = await page.evaluate(() => (window as any).__writes);

  // googleDrive is the winner → 'source' action, no writeBlob call.
  expect(writes.googleDrive.length).toBe(0);
  // localDisk gets fanned out — MUST receive the full byte payload, not an
  // empty buffer left behind by a buffer-transfer footgun in importDb.
  expect(writes.localDisk.length).toBe(1);
  expect(writes.localDisk[0].sizeBytes).toBe(winningBytes.length);
  expect(writes.localDisk[0].sizeBytes).toBeGreaterThan(0);
});
