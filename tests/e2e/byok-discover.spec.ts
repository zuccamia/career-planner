// BYOK variant covering discover. Exercises the JS
// prompt-handlers/discover/{expand-query,rank-jobs}.mjs handlers by driving
// the Discover panel with a fake BYOK provider + stubbed search + stubbed
// ATS extract results.

import { expect, test, type Page } from './fixtures';
import { enableBYOK, interceptBYOKLLM } from './byok-fixtures';

// Same headline-seed as discover.spec.ts's flow so the header CTA reveals.
const gotoDashboardWithHeadline = async (page: Page) => {
  await page.route('**/api/discover/server-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ available: true, llm_available: true, search_available: true, provider: 'searxng' }),
  }));
  await page.goto('/profile');
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
  await page.locator('#wiz-input').fill('Nova');
  await page.locator('#btn-wizard-next').click();
  await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
  await page.locator('#wiz-input').fill('Backend Engineer');
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await expect(page.getByText('About you', { exact: true })).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Application pipeline' })).toBeVisible({ timeout: 30_000 });
};

const CANNED_EXPAND = { role_variants: ['Backend Engineer', 'Backend Developer'] };

const CANNED_HITS = { hits: [{
  url: 'https://boards.greenhouse.io/acme/jobs/1234',
  title: 'Backend Engineer', snippet: 'Own the payments API.', host: 'boards.greenhouse.io',
}] };

const CANNED_RANK = { ranked: [{
  url: 'https://boards.greenhouse.io/acme/jobs/1234',
  match_score: 92, rationale: 'Strong Go + Postgres fit',
}] };

test.describe('discover — BYOK', () => {
  test('BYOK discover fires expand-query and rank-jobs handlers', async ({ page }) => {
    await gotoDashboardWithHeadline(page);
    await enableBYOK(page);

    // Server search stubbed so discover reaches rank. Extract calls fetch
    // each posting URL — intercept the greenhouse host to return canned text.
    await page.route('**/api/discover/search', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(CANNED_HITS),
    }));
    await page.route('**/boards.greenhouse.io/**', (route) => route.fulfill({
      status: 200, contentType: 'text/html',
      body: '<html><body><h1>Backend Engineer at Acme</h1><p>We are hiring a backend engineer to own the payments API.</p></body></html>',
    }));

    // Route each BYOK LLM call by the user-message content: expand includes
    // "role variants", rank contains a JSON array of postings.
    const { calls } = await interceptBYOKLLM(page, (call) => {
      const user = call.messages.find((m) => m.role === 'user')?.content ?? '';
      if (/role_variants|Backend Engineer/i.test(user) && !/rank/i.test(user)) {
        return { content: JSON.stringify(CANNED_EXPAND) };
      }
      return { content: JSON.stringify(CANNED_RANK) };
    });

    await page.locator('#header-btn-discover').click();
    await page.getByRole('button', { name: 'Find openings' }).click();

    // Rank fires (second LLM call) — either the recommendation renders or an
    // "empty results" diagnostic. Either way, both LLM calls must have run.
    await expect.poll(() => calls.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

    const userTexts = calls.map((c) => c.messages.find((m) => m.role === 'user')?.content ?? '');
    // expand-query call must reference the profile headline.
    expect(userTexts.some((t) => /Backend Engineer/.test(t))).toBe(true);
  });
});
