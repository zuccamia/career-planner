import { expect, test } from '@playwright/test';
import { createCompany } from './helpers';

test('user can create a person linked to a company', async ({ page }) => {
  const companyName = 'Notion E2E Labs';
  const personName = 'Ada Lovelace E2E';

  await createCompany(page, {
    submittedName: companyName,
    officialName: companyName,
  });

  await page.goto('/people/new');
  await page.getByLabel('Full name').fill(personName);
  await page.getByLabel('Title').fill('Engineering Manager');
  await page.getByLabel('Company').selectOption({ label: companyName });
  await page.getByLabel('LinkedIn URL').fill('https://www.linkedin.com/in/ada-lovelace-e2e');
  await page.getByLabel('Notes').fill('Met through a recruiting intro.');
  await page.getByRole('button', { name: 'Save person' }).click();

  await expect(page).toHaveURL('/people');
  const personCard = page.locator('li', { hasText: personName }).first();
  await expect(personCard).toBeVisible();
  await expect(personCard).toContainText('Engineering Manager');
  await expect(personCard).toContainText(companyName);
  await expect(personCard.locator('a[href="https://www.linkedin.com/in/ada-lovelace-e2e"]')).toBeVisible();
  await expect(personCard).toContainText('Met through a recruiting intro.');
});

test('person form shows server-side validation errors', async ({ page }) => {
  await page.goto('/people/new');
  await page.locator('form[action="/people"]').evaluate((form: HTMLFormElement) => form.submit());
  await expect(page.getByText('full name is required')).toBeVisible();
});