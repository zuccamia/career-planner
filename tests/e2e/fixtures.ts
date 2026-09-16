// Shared base for e2e specs. `_forceExit` skips Playwright's 5-min
// keep-alive teardown on green runs. Failing runs skip the exit —
// `process.exit(1)` mid-teardown makes Playwright overwrite the real
// assertion with "worker exited unexpectedly" and cascade it to
// unrelated tests on the same worker.
//
// Sporadic 5-min teardown hangs on green runs are a known Playwright
// quirk (CDP/keep-alive races) that no fixture-level workaround has
// solved without causing worse problems.
import { test as base, expect } from '@playwright/test';

let workerSawFailure = false;

export const test = base.extend<{ _trackFailure: void; _disposeDb: void }, { _forceExit: void }>({
  _trackFailure: [async ({}, use, testInfo) => {
    await use();
    if (testInfo.status !== testInfo.expectedStatus) workerSawFailure = true;
  }, { auto: true }],
  // client.mjs disposes on pagehide, but Chromium won't await the worker's
  // async pauseVfs(). Calling it here with a yield lets OPFS release before
  // Playwright's teardown, avoiding the 5-min worker-exit stall.
  _disposeDb: [async ({ page }, use) => {
    await use();
    try {
      await page.evaluate(async () => {
        const { disposeWorker } = await import('/static/js/db/client.mjs');
        disposeWorker();
        // Small yield so the worker's shutdown message round-trips and
        // pauseVfs() actually releases the SAH handles before page.close().
        await new Promise((r) => setTimeout(r, 150));
      });
    } catch {
      // Page may already be closed / navigated — nothing to dispose.
    }
  }, { auto: true }],
  _forceExit: [async ({}, use) => {
    await use();
    if (!workerSawFailure) process.exit(0);
  }, { scope: 'worker', auto: true }],
});

export { expect };
