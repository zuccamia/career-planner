import { expect, test } from '@playwright/test';

test('dashboard and primary navigation render', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Career Planner');
  await expect(page.getByText('Dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Companies tracked')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add company' }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Companies' }).click();
  await expect(page).toHaveURL('/companies');
  await expect(page.getByRole('link', { name: 'Add company' }).first()).toBeVisible();

  await page.getByRole('link', { name: 'People' }).click();
  await expect(page).toHaveURL('/people');
  await expect(page.getByRole('link', { name: 'Add person' })).toBeVisible();

  await page.getByRole('link', { name: 'Engineering blogs' }).click();
  await expect(page).toHaveURL('/engineering-blogs');
  await expect(page.getByLabel('Filter by company')).toBeVisible();
});