import { expect, test, type Page } from '@playwright/test';

// Simulates the GH Pages build by rewriting every top-level HTML response
// so the static-host meta tag reads true. Playwright's route interception
// fires before the browser parses the HTML, so main.mjs sees the "static"
// tag and llmCall takes the JS-only build/parse branch.
const asStaticHost = async (page: Page) => {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    return route.fulfill({
      response,
      body: body.replace(
        'name="static-host" content="false"',
        'name="static-host" content="true"',
      ),
    });
  });
};

// primeBYOK saves a fake BYOK config to IndexedDB via the same helper the
// UI uses. Runs after navigation so the JS module is loaded and can be
// imported.
const primeBYOK = async (page: Page) => {
  await page.evaluate(async () => {
    const mod = await import('/static/js/storage/byok.mjs');
    await mod.saveByokConfig({
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
  });
};

// waitForI18n polls until the browser's i18n bundle has finished loading —
// otherwise t() calls return the raw key and message assertions see the key
// instead of the translation. Uses in-page polling because Playwright's
// waitForFunction doesn't reliably interleave with dynamic-import promises.
const waitForI18n = async (page: Page) => {
  await page.evaluate(async () => {
    const { t } = await import('/static/js/i18n.mjs');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && t('app.name') === 'app.name') {
      await new Promise((r) => setTimeout(r, 50));
    }
  });
};

test.describe('static-host mode', () => {
  test('default deploy renders static-host=false meta tag', async ({ page }) => {
    await page.goto('/dashboard');
    const value = await page.locator('meta[name="static-host"]').getAttribute('content');
    expect(value).toBe('false');
  });

  test('HTML rewrite flips isStaticHost() to true in the browser', async ({ page }) => {
    await asStaticHost(page);
    await page.goto('/dashboard');
    const staticHost = await page.evaluate(async () => {
      const mod = await import('/static/js/host.mjs');
      return mod.isStaticHost();
    });
    expect(staticHost).toBe(true);
  });

  test('llmCall throws no_llm_configured when static host has no BYOK', async ({ page }) => {
    await asStaticHost(page);
    await page.goto('/dashboard');
    await waitForI18n(page);
    const err = await page.evaluate(async () => {
      const { guessCompanyCandidate } = await import('/static/js/rpc.mjs');
      try {
        await guessCompanyCandidate('Acme');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toMatch(/No AI provider is configured/i);
  });

  test('static host + BYOK routes through JS builder/parser without hitting /api/llm', async ({ page }) => {
    // Playwright matches route handlers in reverse-registration order (most
    // recent wins). Register the catch-all asStaticHost first so the more
    // specific mocks below take precedence for their URLs.
    await asStaticHost(page);
    // Log every /api/llm/prompts and /api/llm/parse hit so we can assert none.
    const apiHits: string[] = [];
    await page.route('**/api/llm/prompts/**', (route) => {
      apiHits.push(route.request().url());
      return route.fulfill({ status: 500, body: 'should not be called' });
    });
    await page.route('**/api/llm/parse/**', (route) => {
      apiHits.push(route.request().url());
      return route.fulfill({ status: 500, body: 'should not be called' });
    });
    // Mock the LLM provider to return a plausible guess-candidate response.
    await page.route('https://api.openai.com/v1/chat/completions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            official_name: 'Acme Corp',
            website: 'https://acme.example',
            blog_url: '',
            ats_url: '',
            ats_provider: '',
            reasoning: 'test',
          }) } }],
        }),
      }),
    );

    await page.goto('/dashboard');
    await primeBYOK(page);

    const result = await page.evaluate(async () => {
      const { guessCompanyCandidate } = await import('/static/js/rpc.mjs');
      return guessCompanyCandidate('acme');
    });

    expect(apiHits).toEqual([]);
    expect(result.candidate.official_name).toBe('Acme Corp');
    expect(result.candidate.website).toBe('https://acme.example');
  });
});
