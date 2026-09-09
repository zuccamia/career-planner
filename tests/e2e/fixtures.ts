// Shared base for e2e specs. Force-exits each worker after all its tests
// finish, skipping Playwright's own teardown which holds a keep-alive
// socket to the webServer open for 5 minutes. Exits unconditionally now —
// the `line` reporter flushes each test's assertion output before worker
// teardown, so preserving failing-test output no longer requires waiting
// for Playwright's natural shutdown.
import { test as base, expect } from '@playwright/test';

let workerSawFailure = false;

export const test = base.extend<{ _trackFailure: void }, { _forceExit: void }>({
  _trackFailure: [async ({}, use, testInfo) => {
    await use();
    if (testInfo.status !== testInfo.expectedStatus) workerSawFailure = true;
  }, { auto: true }],
  _forceExit: [async ({}, use) => {
    await use();
    // Failing tests already emitted their diagnostic. Non-zero exit on
    // failure so the harness still marks the worker as failed; zero on
    // green so cleanup is silent.
    process.exit(workerSawFailure ? 1 : 0);
  }, { scope: 'worker', auto: true }],
});

export { expect };
