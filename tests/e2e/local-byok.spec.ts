import { expect, test, type Page } from '@playwright/test';

// BYOK (bring-your-own-key) settings panel. Playwright starts the server with
// empty LLM_* env vars — so /api/llm/server-status returns available:false.
// The server-side LLM path is never exposed as a toggle: users either
// configure BYOK or (server permitting) fall back to the server-side LLM
// silently. "Clear key" is the escape hatch. One test uses page.route to
// simulate a server-side-available deploy for extra sidebar-badge coverage.
//
// The provider network round trip is mocked via page.route so tests never
// hit a real /models endpoint; llm-client.mjs shape is covered in Go via
// internal/http/byok_test.go.

const gotoSettings = async (page: Page) => {
  await page.goto('/local/settings');
  await expect(page.getByText('AI provider')).toBeVisible({ timeout: 30_000 });
};

// mockProviderModels intercepts the OpenAI-compatible /models call that
// testConnection makes. Return ok=false to simulate a failing test.
const mockProviderModels = async (page: Page, ok = true) => {
  await page.route('https://api.openai.com/v1/models', route =>
    ok
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }) })
      : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_api_key' }) }),
  );
};

const fillAndTest = async (page: Page, key = 'sk-test-abcdef') => {
  await page.locator('#byok-api-key').fill(key);
  // The scraper panel also has a "Test connection" button. Click the AI
  // panel's directly by id to disambiguate.
  await page.locator('#btn-byok-test').click();
  await expect(page.locator('#byok-test-result')).toContainText(/Reached provider/);
};

test.describe('local settings — AI provider (BYOK-only server)', () => {
  test('BYOK fields visible with sensible defaults and Save disabled', async ({ page }) => {
    await gotoSettings(page);

    await expect(page.locator('#byok-fields')).toBeVisible();
    await expect(page.locator('#byok-base-url')).toHaveValue('https://api.openai.com/v1');
    await expect(page.locator('#byok-model')).toHaveValue('gpt-4o-mini');
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeDisabled();
  });

  test('successful test connection enables Save; editing any field disables it again', async ({ page }) => {
    await mockProviderModels(page);
    await gotoSettings(page);
    await fillAndTest(page);
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeEnabled();

    await page.locator('#byok-api-key').fill('sk-different');
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeDisabled();
  });

  test('save persists BYOK config across reload and updates the sidebar badge', async ({ page }) => {
    await mockProviderModels(page);
    await gotoSettings(page);
    await fillAndTest(page);
    await page.getByRole('button', { name: 'Save AI provider settings' }).click();
    await expect(page.locator('#byok-status')).toContainText(/gpt-4o-mini/);

    await page.reload();
    await expect(page.getByText('AI provider')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#byok-api-key')).toHaveValue('sk-test-abcdef');
    // Persisted config was previously tested → Save stays enabled on reload.
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeEnabled();

    await page.goto('/local/dashboard');
    await expect(page.locator('#ai-mode-badge')).toContainText(/BYOK/);
  });

  test('sidebar shows amber "setup needed" when BYOK is off and no server-side LLM', async ({ page }) => {
    // Fresh browser, no BYOK saved, empty LLM_* env → neither path is
    // available, so the badge nudges the user toward Settings.
    await page.goto('/local/dashboard');
    await expect(page.locator('#ai-mode-badge')).toContainText(/setup needed/i);
  });
});

test.describe('local settings — AI provider (server-side LLM available, mocked)', () => {
  // Simulate a server with LLM_* configured by intercepting the status endpoint.
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/llm/server-status', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, provider: 'openai-compatible', model: 'gpt-4o-mini' }) }),
    );
  });

  test('BYOK fields visible even when server-side LLM is available', async ({ page }) => {
    await gotoSettings(page);
    await expect(page.locator('#byok-fields')).toBeVisible();
  });

  test('clear key wipes fields, disables Save, and clears status badge', async ({ page }) => {
    await mockProviderModels(page);
    await gotoSettings(page);
    await fillAndTest(page);
    await page.getByRole('button', { name: 'Save AI provider settings' }).click();
    await expect(page.locator('#byok-status')).toContainText(/gpt-4o-mini/);

    page.once('dialog', d => d.accept());
    // The scraper panel also has a "Clear key" button; scope to the AI one.
    await page.locator('#btn-byok-clear').click();
    await expect(page.locator('#byok-api-key')).toHaveValue('');
    await expect(page.locator('#byok-status')).toBeEmpty();
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeDisabled();
  });
});
