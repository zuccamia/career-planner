import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const runId = `${process.pid}-${Date.now()}`;
const testDbDir = path.join(__dirname, 'tmp', 'playwright');
const testDbPath = path.join(testDbDir, `e2e-${runId}.sqlite3`);
const chromeExecutablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(testDbDir, { recursive: true });

export default defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: `rm -f ${testDbPath} && go run ./cmd/web`,
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    env: {
      DATABASE_PATH: testDbPath,
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