import { expect, test } from '@playwright/test';
import { createCompany, createEngineeringNote } from './helpers';

test('user can create, edit, delete, and filter engineering blog notes', async ({ page }) => {
  const cloudflareCompany = 'Cloudflare E2E, Inc.';
  const figmaCompany = 'Figma E2E, Inc.';

  await createCompany(page, {
    submittedName: cloudflareCompany,
    officialName: cloudflareCompany,
  });

  await page.getByRole('link', { name: /View engineering blog collection/ }).click();
  await expect(page.getByRole('button', { name: 'Save engineering note' })).toBeVisible();

  await createEngineeringNote(page, {
    articleURL: 'https://blog.cloudflare.com/how-we-built-edge-services/',
    notes: 'Strong write-up on edge runtime architecture.',
  });

  await expect(page.getByRole('link', { name: 'https://blog.cloudflare.com/how-we-built-edge-services/', exact: true })).toBeVisible();
  await expect(page.getByText('Strong write-up on edge runtime architecture.')).toBeVisible();

  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Article URL').fill('https://blog.cloudflare.com/edge-runtime-deep-dive/');
  await page.getByLabel('Your notes').fill('Updated notes after a second read.');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('link', { name: 'https://blog.cloudflare.com/edge-runtime-deep-dive/', exact: true })).toBeVisible();
  await expect(page.getByText('Updated notes after a second read.')).toBeVisible();

  await createCompany(page, {
    submittedName: figmaCompany,
    officialName: figmaCompany,
  });
  await page.getByRole('link', { name: /View engineering blog collection/ }).click();
  await createEngineeringNote(page, {
    articleURL: 'https://www.figma.com/blog/how-figma-scales/',
    notes: 'Interesting notes on scaling multiplayer editing.',
  });

  await page.goto('/engineering-blogs');
  await expect(page.getByRole('link', { name: cloudflareCompany, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: figmaCompany, exact: true })).toBeVisible();

  await page.getByLabel('Filter by company').selectOption({ label: `${cloudflareCompany} (1)` });
  await page.getByRole('button', { name: 'Apply filter' }).click();

  await expect(page.getByRole('link', { name: cloudflareCompany, exact: true })).toBeVisible();
  await expect(page.getByText('Updated notes after a second read.')).toBeVisible();
  await expect(page.getByRole('link', { name: figmaCompany, exact: true })).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();

  await expect(page.getByText('Updated notes after a second read.')).toHaveCount(0);
});

test('engineering blog forms show validation errors', async ({ page }) => {
  const githubCompany = 'GitHub E2E, Inc.';

  await createCompany(page, {
    submittedName: githubCompany,
    officialName: githubCompany,
  });

  await page.getByRole('link', { name: /View engineering blog collection/ }).click();
  await page.getByLabel('Your notes').fill('Missing URL should fail.');
  await page.locator('form[action$="/engineering-notes"]').evaluate((form: HTMLFormElement) => form.submit());

  await expect(page.getByText('article URL is required')).toBeVisible();

  await createEngineeringNote(page, {
    articleURL: 'https://github.blog/engineering/example/',
    notes: 'Initial note.',
  });
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Article URL').fill('');
  await page.locator('form[action*="/engineering-blogs/"][action$="/edit"]').evaluate((form: HTMLFormElement) => form.submit());

  await expect(page.getByText('article URL is required')).toBeVisible();
});