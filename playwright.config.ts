import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const testPort = 8081;
const testBaseURL = `http://127.0.0.1:${testPort}`;
const chromeExecutablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE
  ?? (process.env.CI ? undefined : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

export default defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [['list']],
  // Hard ceiling per run (per shard on CI). Green runs finish in ~2m. Any
  // hang past that is a real signal something's wrong — cap at 10m so a
  // pathological failure doesn't burn CI budget silently.
  globalTimeout: 10 * 60 * 1000,
  use: {
    baseURL: testBaseURL,
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: `./bin/web-test`,
    url: testBaseURL,
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
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
