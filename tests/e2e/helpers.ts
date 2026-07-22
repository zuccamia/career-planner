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
  await expect(page).toHaveURL(/\/companies\/\d+$/);
  await expect(page.getByRole('heading', { name: input.officialName ?? input.name })).toBeVisible();
}

export async function createEngineeringNote(
  page: Page,
  input: { articleURL: string; notes: string },
) {
  await expect(page).toHaveURL(/\/companies\/\d+\/engineering-blogs$/);
  const currentPath = new URL(page.url()).pathname;
  const form = page.locator(`form[action="${currentPath}"]`);

  await page.getByLabel('Article URL').fill(input.articleURL);
  await page.getByLabel('Your notes').fill(input.notes);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(currentPath);
}

export async function createPerson(
  page: Page,
  input: {
    fullName: string;
    title?: string;
    companyName?: string;
    linkedInURL?: string;
    notes?: string;
  },
) {
  await page.goto('/people/new');
  await page.getByLabel('Full name').fill(input.fullName);
  if (input.title !== undefined) {
    await page.getByLabel('Title').fill(input.title);
  }
  if (input.companyName !== undefined) {
    await page.getByLabel('Company').selectOption({ label: input.companyName });
  }
  if (input.linkedInURL !== undefined) {
    await page.getByLabel('LinkedIn URL').fill(input.linkedInURL);
  }
  if (input.notes !== undefined) {
    await page.getByLabel('Notes').fill(input.notes);
  }
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL('/people');
}

export async function createApplication(
  page: Page,
  input: {
    companyName: string;
    roleTitle: string;
    personName?: string;
    status?: string;
    jobPostingURL?: string;
    jobDescriptionRaw?: string;
    notes?: string;
  },
) {
  await page.goto('/applications/new');
  await page.getByLabel('Company').selectOption({ label: input.companyName });
  if (input.personName !== undefined) {
    await page.getByLabel('Person').selectOption({ label: input.personName });
  }
  await page.getByLabel('Role title').fill(input.roleTitle);
  if (input.status !== undefined) {
    await page.getByLabel('Status').selectOption(input.status);
  }
  if (input.jobPostingURL !== undefined) {
    await page.getByLabel('Job posting URL').fill(input.jobPostingURL);
  }
  if (input.jobDescriptionRaw !== undefined) {
    await page.getByLabel('Job description (raw)').fill(input.jobDescriptionRaw);
  }
  if (input.notes !== undefined) {
    await page.getByLabel('Notes').fill(input.notes);
  }
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/applications\/\d+$/);
}