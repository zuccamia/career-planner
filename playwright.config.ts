import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const testDbDir = path.join(__dirname, 'tmp', 'playwright');
const testDbPath = path.join(testDbDir, 'test.sqlite3');
const testPort = 8081;
const testBaseURL = `http://127.0.0.1:${testPort}`;
const chromeExecutablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(testDbDir, { recursive: true });

async function resetTestServer() {
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      `${testBaseURL}/test/reset`,
      { method: 'POST' },
      (res) => {
        if (res.statusCode === 204) {
          resolve();
          return;
        }
        reject(new Error(`test reset failed with status ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export default defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  globalSetup: path.join(__dirname, 'tests', 'e2e', 'global-setup.ts'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: testBaseURL,
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: `go run ./cmd/web`,
    url: testBaseURL,
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
      DATABASE_PATH: testDbPath,
      APP_ENV: 'test',
      APP_ADDR: `:${testPort}`,
      LLM_PROVIDER: '',
      LLM_MODEL: '',
      LLM_BASE_URL: '',
      LLM_API_KEY: '',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        launchOptions: {
          executablePath: chromeExecutablePath,
        },
      },
    },
  ],
});

export { resetTestServer };