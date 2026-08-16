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
  await page.goto('/settings');
  await expect(page.getByText('AI provider')).toBeVisible({ timeout: 30_000 });
};

// mockProviderModels intercepts the OpenAI-compatible /chat/completions ping
// that testConnection makes. Return ok=false to simulate a failing test.
const mockProviderModels = async (page: Page, ok = true) => {
  await page.route('https://api.openai.com/v1/chat/completions', route =>
    ok
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) })
      : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_api_key' }) }),
  );
};

const fillAndTest = async (page: Page, key = 'sk-test-abcdef') => {
  await page.locator('#llm-api-key').fill(key);
  // The scraper panel also has a "Test connection" button. Click the AI
  // panel's directly by id to disambiguate.
  await page.locator('#btn-llm-test').click();
  await expect(page.locator('#llm-test-result')).toContainText(/Reached provider/);
};

test.describe('local settings — AI provider (BYOK-only server)', () => {
  test('BYOK fields visible with sensible defaults and Save disabled', async ({ page }) => {
    await gotoSettings(page);

    await expect(page.locator('#llm-fields')).toBeVisible();
    await expect(page.locator('#llm-base-url')).toHaveValue('https://api.openai.com/v1');
    await expect(page.locator('#llm-model')).toHaveValue('gpt-4o-mini');
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeDisabled();
  });

  test('successful test connection enables Save; editing any field disables it again', async ({ page }) => {
    await mockProviderModels(page);
    await gotoSettings(page);
    await fillAndTest(page);
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeEnabled();

    await page.locator('#llm-api-key').fill('sk-different');
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeDisabled();
  });

  test('save persists BYOK config across reload and updates the sidebar badge', async ({ page }) => {
    await mockProviderModels(page);
    await gotoSettings(page);
    await fillAndTest(page);
    await page.getByRole('button', { name: 'Save AI provider settings' }).click();
    await expect(page.locator('#llm-status')).toContainText(/gpt-4o-mini/);

    await page.reload();
    await expect(page.getByText('AI provider')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#llm-api-key')).toHaveValue('sk-test-abcdef');
    // Persisted config was previously tested → Save stays enabled on reload.
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeEnabled();

    await page.goto('/dashboard');
    await expect(page.locator('#ai-mode-badge')).toContainText(/BYOK/);
  });

  // Regression: testConnection used to hit GET /models. Providers like MiniMax
  // don't implement that endpoint and return "model name not found in request
  // body or URL". Confirm the test now POSTs /chat/completions with the model
  // and a >1 token budget (some providers 400 with "output limit was reached"
  // when max_tokens=1 doesn't leave room for any content).
  test('test connection POSTs /chat/completions with model and >1 token budget', async ({ page }) => {
    let seenMethod = '';
    let seenBody: Record<string, unknown> = {};
    await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
      const req = route.request();
      seenMethod = req.method();
      try { seenBody = JSON.parse(req.postData() || '{}'); } catch { /* ignore */ }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
    });
    await gotoSettings(page);
    await fillAndTest(page);
    expect(seenMethod).toBe('POST');
    expect(seenBody.model).toBe('gpt-4o-mini');
    // Token budget of exactly 1 caused "output limit was reached" on MiniMax.
    const budget = (seenBody.max_tokens ?? seenBody.max_completion_tokens) as number;
    expect(budget).toBeGreaterThan(1);
  });

  // Regression: newer OpenAI models (o1, gpt-5, some 4.x) reject `max_tokens`
  // with { code: "unsupported_parameter", param: "max_tokens" } and require
  // `max_completion_tokens`. Confirm testConnection retries with the new key
  // on that structured signal (not by regexing the message).
  test('test connection falls back to max_completion_tokens on unsupported_parameter', async ({ page }) => {
    const sawKey: string[] = [];
    await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if ('max_tokens' in body) {
        sawKey.push('max_tokens');
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: 'invalid_request_error',
              param: 'max_tokens',
              code: 'unsupported_parameter',
            },
          }),
        });
        return;
      }
      sawKey.push('max_completion_tokens');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
    });
    await gotoSettings(page);
    await fillAndTest(page);
    expect(sawKey).toEqual(['max_tokens', 'max_completion_tokens']);
  });

  test('sidebar shows amber "setup needed" when BYOK is off and no server-side LLM', async ({ page }) => {
    // Fresh browser, no BYOK saved, empty LLM_* env → neither path is
    // available, so the badge nudges the user toward Settings.
    await page.goto('/dashboard');
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
    await expect(page.locator('#llm-fields')).toBeVisible();
  });

  test('clear key wipes fields, disables Save, and status badge falls back to server LLM', async ({ page }) => {
    await mockProviderModels(page);
    await gotoSettings(page);
    await fillAndTest(page);
    await page.getByRole('button', { name: 'Save AI provider settings' }).click();
    await expect(page.locator('#llm-status')).toContainText(/gpt-4o-mini/);

    page.once('dialog', d => d.accept());
    // The scraper panel also has a "Clear key" button; scope to the AI one.
    await page.locator('#btn-llm-clear').click();
    await expect(page.locator('#llm-api-key')).toHaveValue('');
    // Server LLM is mocked as available, so clearing BYOK reveals the
    // server-side model in the status badge rather than emptying it.
    await expect(page.locator('#llm-status')).toContainText(/gpt-4o-mini/);
    await expect(page.getByRole('button', { name: 'Save AI provider settings' })).toBeDisabled();
  });
});
