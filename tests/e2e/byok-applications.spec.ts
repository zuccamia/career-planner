// BYOK variant covering extract-job-description. Exercises the JS
// prompt-handlers/applications/extract-job-description handler (build +
// parse) end-to-end via the details panel's Re-extract action.

import { expect, test, type Page } from './fixtures';
import { enableBYOK, interceptBYOKLLM, scriptedBYOKResponder } from './byok-fixtures';

const gotoApps = async (page: Page) => {
  await page.goto('/applications');
  await expect(page.getByText('Application tracker', { exact: true })).toBeVisible({ timeout: 30_000 });
};

const seedApp = async (page: Page) => {
  await gotoApps(page);
  return page.evaluate(async () => {
    const [{ createCompany }, { createApplication }] = await Promise.all([
      import('/static/js/entities/companies.mjs'),
      import('/static/js/entities/applications.mjs'),
    ]);
    const companyId = await createCompany({ official_name: 'Acme Corp' });
    const applicationId = await createApplication({
      company_id: companyId, role_title: 'Backend Engineer', status: 'lead',
      job_description_raw: 'We are hiring a backend engineer to own the payments API.',
    });
    return { companyId, applicationId };
  });
};

const CANNED_EXTRACT = {
  role_title: 'Backend Engineer',
  role_level: 'senior',
  employment_type: 'full-time',
  skills: ['Go', 'PostgreSQL'],
  responsibilities: ['Own the payments API'],
  summary: 'Own payments backend end-to-end.',
  reasoning: 'Explicit signals: payments, backend, ownership.',
};

test.describe('extract-job-description — BYOK', () => {
  test('Re-extract runs the JS extract-job-description handler through BYOK', async ({ page }) => {
    await seedApp(page);
    await gotoApps(page);
    await enableBYOK(page);
    const { calls } = await interceptBYOKLLM(page, scriptedBYOKResponder([
      { content: JSON.stringify(CANNED_EXTRACT) },
    ]));

    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: /Open Backend Engineer/ }).click();
    const panel = page.locator('#details-panel');
    await expect(panel).toBeVisible();

    await page.locator('#btn-details-extract').click();
    // The canned summary text lands on the panel after re-extract completes.
    await expect(panel.getByText('Own payments backend end-to-end.')).toBeVisible({ timeout: 15_000 });

    expect(calls).toHaveLength(1);
    // build() must interpolate the raw JD into the user message — regression
    // guard for rpc.mjs ↔ handler field-name drift.
    const userMessage = calls[0].messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('own the payments API');
  });
});
