// BYOK variant covering companies/lookup + build-dossier. Exercises the
// JS prompt-handlers/companies/{lookup,build-dossier}.mjs handlers via the
// editor's Look-up button and the details panel's Build-dossier action.

import { expect, test, type Page } from './fixtures';
import { enableBYOK, interceptBYOKLLM } from './byok-fixtures';

const gotoCompanies = async (page: Page) => {
  await page.goto('/companies');
  await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 30_000 });
};

const CANNED_LOOKUP = {
  official_name: 'Acme Corporation',
  website: 'https://acme.example',
  blog_url: 'https://acme.example/engineering',
  ats_url: 'https://boards.greenhouse.io/acme',
  ats_provider: 'Greenhouse',
  reasoning: 'Matched Acme Corp against public web presence.',
};

const CANNED_DOSSIER = {
  company_summary: 'Acme sells widgets to enterprises.',
  what_the_company_does: 'Enterprise widget platform.',
  target_customers: ['Fortune 500'],
  product_areas: ['Widgets', 'Adapters'],
  business_model_clues: ['Annual contracts'],
  company_culture_notes: ['Written culture'],
  reasoning: 'Extracted from marketing site.',
};

test.describe('companies flows — BYOK', () => {
  test('Look-up runs the JS companies/lookup handler through BYOK', async ({ page }) => {
    await gotoCompanies(page);
    await enableBYOK(page);
    const { calls } = await interceptBYOKLLM(page, () => ({
      // parse() at prompt-handlers/companies/lookup.mjs decodes the LLM
      // content directly as the candidate object (no envelope).
      content: JSON.stringify(CANNED_LOOKUP),
    }));

    await page.getByRole('button', { name: 'Add company' }).click();
    await page.getByLabel('Official name').fill('Acme');
    await page.locator('#btn-lookup').click();

    // Toast + auto-filled fields confirm the handler round-trip.
    await expect(page.locator('#toast')).toContainText(/reason|filled/i, { timeout: 15_000 });
    await expect(page.getByLabel('Website')).toHaveValue('https://acme.example');
    expect(calls).toHaveLength(1);
    const userMessage = calls[0].messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('Acme');
  });

  test('Build dossier runs the JS build-dossier handler through BYOK', async ({ page }) => {
    await gotoCompanies(page);
    await enableBYOK(page);
    await interceptBYOKLLM(page, () => ({ content: JSON.stringify(CANNED_DOSSIER) }));

    // Create a company via the editor without triggering lookup.
    await page.getByRole('button', { name: 'Add company' }).click();
    await page.getByLabel('Official name').fill('Acme Corp');
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#toast')).toContainText(/Created company/);

    const card = page.locator('#list-content li', { hasText: 'Acme Corp' });
    await card.getByRole('button', { name: /Open Acme Corp/ }).click();
    await page.locator('#btn-dossier-build').click();

    // Success note under the dossier section confirms the flow completed.
    await expect(page.locator('#dossier-note')).toContainText(/Dossier built|dossier/i, { timeout: 15_000 });
  });
});
