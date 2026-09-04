// Shared base for e2e specs. Force-exits each worker after all its tests
// finish, skipping Playwright's own teardown which holds a keep-alive
// socket to the webServer open for 5 minutes. Green runs only — exiting
// mid-teardown on a failing test makes Playwright overwrite the real
// assertion error with "worker exited unexpectedly", so failing runs
// accept the tail to keep the diagnostic intact.
import { test as base, expect } from '@playwright/test';

let workerSawFailure = false;

export const test = base.extend<{ _trackFailure: void }, { _forceExit: void }>({
  _trackFailure: [async ({}, use, testInfo) => {
    await use();
    if (testInfo.status !== testInfo.expectedStatus) workerSawFailure = true;
  }, { auto: true }],
  _forceExit: [async ({}, use) => {
    await use();
    if (!workerSawFailure) process.exit(0);
  }, { scope: 'worker', auto: true }],
});

export { expect };
