import { expect, type Page } from '@playwright/test';

export async function createCompany(
  page: Page,
  input: {
	  name: string;
    officialName?: string;
    website?: string;
    techBlogURL?: string;
    atsURL?: string;
    atsProvider?: string;
  },
) {
  await page.goto('/companies/new');
  await page.getByLabel('Company name').fill(input.name);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('button', { name: 'Confirm company' })).toBeVisible();

  if (input.officialName !== undefined) {
    await page.getByLabel('Official name').fill(input.officialName);
  }
  if (input.website !== undefined) {
    await page.getByLabel('Website').fill(input.website);
  }
  if (input.techBlogURL !== undefined) {
    await page.getByLabel('Tech blog URL').fill(input.techBlogURL);
  }
  if (input.atsURL !== undefined) {
    await page.getByLabel('ATS URL').fill(input.atsURL);
  }
  if (input.atsProvider !== undefined) {
    await page.getByLabel('ATS provider').fill(input.atsProvider);
  }

  await page.getByRole('button', { name: 'Confirm company' }).click();
  await expect(page.getByRole('heading', { name: input.officialName ?? input.name })).toBeVisible();
}

export async function createEngineeringNote(
  page: Page,
  input: { articleURL: string; notes: string },
) {
  await page.getByLabel('Article URL').fill(input.articleURL);
  await page.getByLabel('Your notes').fill(input.notes);
  await page.getByRole('button', { name: 'Save engineering note' }).click();
}