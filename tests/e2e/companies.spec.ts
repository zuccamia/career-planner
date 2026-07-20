import { expect, test } from '@playwright/test';
import { createCompany } from './helpers';

test('user can create, edit, and delete a company', async ({ page }) => {
  const companyName = 'Stripe E2E Co.';
  const updatedCompanyName = 'Stripe E2E Co. Updated';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
    website: 'https://stripe.com',
    techBlogURL: 'https://stripe.com/blog/engineering',
    atsURL: 'https://stripe.com/jobs/search',
    atsProvider: 'Greenhouse',
  });

  await expect(page.getByRole('link', { name: 'https://stripe.com', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'https://stripe.com/blog/engineering', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'https://stripe.com/jobs/search', exact: true })).toBeVisible();
  await expect(page.getByText('Greenhouse')).toBeVisible();
  await expect(page.getByText('No dossier yet. Build one to generate a first-pass company summary.')).toBeVisible();

  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page.getByText('Edit company')).toBeVisible();

  await page.getByLabel('Official name').fill(updatedCompanyName);
  await page.getByLabel('Website').fill('https://www.stripe.com');
  await page.getByLabel('ATS provider').fill('Ashby');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('heading', { name: updatedCompanyName })).toBeVisible();
  await expect(page.getByRole('link', { name: 'https://www.stripe.com', exact: true })).toBeVisible();
  await expect(page.getByText('Ashby')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete company' }).click();

  await expect(page).toHaveURL('/companies');
  await expect(page.getByText(updatedCompanyName)).toHaveCount(0);
});

test('company forms surface validation errors', async ({ page }) => {
  await page.goto('/companies/new');
  await page.locator('form[action="/companies/new"]').evaluate((form: HTMLFormElement) => form.submit());
  await expect(page.getByText('Company name is required.')).toBeVisible();

  await page.goto('/companies/new');
  await page.getByLabel('Company name').fill('Linear');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Confirm company' })).toBeVisible();

  await page.locator('input[name="official_name"]').evaluate((input: HTMLInputElement) => {
    input.value = '';
  });
  await page.getByRole('button', { name: 'Confirm company' }).click();

  await expect(page.getByText('official company name is required')).toBeVisible();
});

test('companies index lists saved companies', async ({ page }) => {
  const officialName = 'Vercel E2E Inc.';

  await createCompany(page, {
    name: officialName,
    officialName,
    website: 'https://vercel.com',
  });

  await page.goto('/companies');
  const companyCard = page.locator('a[href^="/companies/"]', { hasText: officialName }).first();
  await expect(companyCard).toBeVisible();
  await expect(companyCard).toContainText('https://vercel.com');
});