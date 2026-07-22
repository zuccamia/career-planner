import { expect, test } from '@playwright/test';
import { createApplication, createCompany, createPerson } from './helpers';
import { resetTestServer } from '../../playwright.config';

test.beforeEach(async () => {
  await resetTestServer();
});

test('user can create and view an application', async ({ page }) => {
  const companyName = 'Google E2E Labs';
  const personName = 'Ada Recruiter E2E';
  const roleTitle = 'Software Engineering Intern';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await createPerson(page, {
    fullName: personName,
    companyName,
  });

  await createApplication(page, {
    companyName,
    personName,
    roleTitle,
    status: 'applied',
    jobPostingURL: 'https://careers.example.com/google-swe-intern',
    jobDescriptionRaw: 'Raw job description text for internship.',
    notes: 'Need transcript before submission.',
  });

  await expect(page.getByRole('heading', { name: roleTitle })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View original posting' })).toHaveAttribute('href', 'https://careers.example.com/google-swe-intern');
  await expect(page.getByText(`${companyName} · ${personName}`, { exact: true })).toBeVisible();
  await expect(page.getByText(personName, { exact: true })).toBeVisible();
  await expect(page.getByText('Need transcript before submission.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Job description' })).toBeVisible();
  await expect(page.getByText('No structured job description yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Extract structured description' })).toBeVisible();
  await expect(page.getByText('Raw job description', { exact: true })).toBeVisible();

  await page.goto('/applications');
  const applicationCard = page.locator('a[href^="/applications/"]', { hasText: roleTitle }).first();
  await expect(applicationCard).toBeVisible();
  await expect(applicationCard).toContainText(companyName);
  await expect(applicationCard).toContainText('applied');
});

test('application form shows validation errors', async ({ page }) => {
  const companyName = 'Application Validation Co.';
  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await page.goto('/applications/new');
  await page.getByLabel('Company').selectOption({ label: companyName });
  await page.locator('form[action="/applications"]').evaluate((form: HTMLFormElement) => form.submit());
  await expect(page.getByText('role title is required')).toBeVisible();
});

test('user can edit and delete an application', async ({ page }) => {
  const companyName = 'Application Edit E2E Co.';
  const updatedCompanyName = 'Application Edit E2E Co. Updated';
  const personName = 'Original Recruiter E2E';
  const updatedPersonName = 'Updated Recruiter E2E';
  const roleTitle = 'Backend Engineer Intern';
  const updatedRoleTitle = 'Software Engineer Intern';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await createCompany(page, {
    name: updatedCompanyName,
    officialName: updatedCompanyName,
  });

  await createPerson(page, {
    fullName: personName,
    companyName,
  });

  await createPerson(page, {
    fullName: updatedPersonName,
    companyName: updatedCompanyName,
  });

  await createApplication(page, {
    companyName,
    personName,
    roleTitle,
    status: 'wishlist',
    jobPostingURL: 'https://jobs.example.com/backend-intern',
    jobDescriptionRaw: 'Original job description.',
    notes: 'Original note.',
  });

  await page.getByRole('link', { name: 'Edit application' }).click();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  await expect(page.getByText('Edit application')).toBeVisible();

  await page.getByLabel('Company').selectOption({ label: updatedCompanyName });
  await page.getByLabel('Person').selectOption({ label: updatedPersonName });
  await page.getByLabel('Role title').fill(updatedRoleTitle);
  await page.getByLabel('Status').selectOption('applied');
  await page.getByLabel('Job posting URL').fill('https://jobs.example.com/software-engineer-intern');
  await page.getByLabel('Job description (raw)').fill('Updated job description.');
  await page.getByLabel('Notes').fill('Updated note.');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page).toHaveURL(/\/applications\/\d+$/);
  await expect(page.getByRole('heading', { name: updatedRoleTitle })).toBeVisible();
  await expect(page.getByText(`${updatedCompanyName} · ${updatedPersonName}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Updated note.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View original posting' })).toHaveAttribute('href', 'https://jobs.example.com/software-engineer-intern');
  await expect(page.locator('span', { hasText: 'applied' }).first()).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete application' }).click();

  await expect(page).toHaveURL('/applications');
  await expect(page.getByText(updatedRoleTitle)).toHaveCount(0);
});