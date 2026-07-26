import { expect, test } from '@playwright/test';
import { createCompany, createPerson } from './helpers';
import { resetTestServer } from '../../playwright.config';

test.beforeEach(async () => {
  await resetTestServer();
});

test('user can create a person linked to a company', async ({ page }) => {
  const companyName = 'Notion E2E Labs';
  const personName = 'Ada Lovelace E2E';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await page.goto('/people/new');
  await page.getByLabel('Full name').fill(personName);
  await page.getByLabel('Title').fill('Engineering Manager');
  await page.getByLabel('Company', { exact: true }).selectOption({ label: companyName });
  await page.getByLabel('LinkedIn URL').fill('https://www.linkedin.com/in/ada-lovelace-e2e');
  await page.getByLabel('Notes').fill('Met through a recruiting intro.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page).toHaveURL('/people');
  const personCard = page.locator('li', { hasText: personName }).first();
  await expect(personCard).toBeVisible();
  await expect(personCard).toContainText('Engineering Manager');
  await expect(personCard).toContainText(companyName);
  await expect(personCard).toContainText('Met through a recruiting intro.');
});

test('person form shows server-side validation errors', async ({ page }) => {
  await page.goto('/people/new');
  await page.locator('form[action="/people"]').evaluate((form: HTMLFormElement) => form.submit());
  await expect(page.getByText('full name is required')).toBeVisible();
});

test('user can edit and delete a person', async ({ page }) => {
  const companyName = 'Linear E2E Labs';
  const updatedCompanyName = 'Linear E2E Labs Updated';
  const personName = 'Grace Hopper E2E';
  const updatedPersonName = 'Grace Brewster Hopper E2E';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await createCompany(page, {
    name: updatedCompanyName,
    officialName: updatedCompanyName,
  });

  await page.goto('/people/new');
  await page.getByLabel('Full name').fill(personName);
  await page.getByLabel('Title').fill('Staff Engineer');
  await page.getByLabel('Company', { exact: true }).selectOption({ label: companyName });
  await page.getByLabel('LinkedIn URL').fill('https://www.linkedin.com/in/grace-hopper-e2e');
  await page.getByLabel('Notes').fill('Original notes.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page).toHaveURL('/people');

  const originalCard = page.locator('li', { hasText: personName }).first();
  await originalCard.getByRole('link', { name: new RegExp(`Edit person ${personName}`) }).click();

  await expect(page).toHaveURL(/\/people\/\d+\/edit$/);
  await page.getByLabel('Full name').fill(updatedPersonName);
  await page.getByLabel('Title').fill('Distinguished Engineer');
  await page.getByLabel('Company', { exact: true }).selectOption({ label: updatedCompanyName });
  await page.getByLabel('LinkedIn URL').fill('https://www.linkedin.com/in/grace-brewster-hopper-e2e');
  await page.getByLabel('Notes').fill('Updated notes.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page).toHaveURL('/people');
  const updatedCard = page.locator('li', { hasText: updatedPersonName }).first();
  await expect(updatedCard).toContainText('Distinguished Engineer');
  await expect(updatedCard).toContainText(updatedCompanyName);
  await expect(updatedCard).toContainText('Updated notes.');

  page.once('dialog', (dialog) => dialog.accept());
  await updatedCard.getByRole('button', { name: `Delete person ${updatedPersonName}` }).click();

  await expect(page).toHaveURL('/people');
  await expect(page.locator('li', { hasText: updatedPersonName })).toHaveCount(0);
});

test('user can create and view communication threads for a person', async ({ page }) => {
  const companyName = 'Threads E2E Labs';
  const personName = 'Katherine Johnson E2E';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await createPerson(page, {
    fullName: personName,
    title: 'Engineering Director',
    companyName,
    notes: 'Met at a meetup.',
  });

  await page.locator('li', { hasText: personName }).first().click({ position: { x: 40, y: 40 } });
  await expect(page).toHaveURL(/\/people\/\d+$/);

  await page.getByLabel('Subject').fill('Initial outreach');
  await page.getByLabel('Channel').selectOption('email');
  await page.getByRole('button', { name: 'Add thread' }).click();

  await expect(page).toHaveURL(/\/communication-threads\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Initial outreach' })).toBeVisible();
  await expect(page.getByText('No entries yet.')).toBeVisible();

  await page.goto('/people');
  await page.locator('li', { hasText: personName }).first().click({ position: { x: 40, y: 40 } });
  const threadCard = page.locator('li', { hasText: 'Initial outreach' }).first();
  await expect(threadCard).toContainText('Initial outreach');
  await expect(threadCard).toContainText('Last activity');
  await expect(page.getByRole('heading', { name: 'Start a thread' })).toBeVisible();
  await expect(page.getByLabel('Subject')).toBeVisible();
  const createThreadButton = page.getByRole('button', { name: 'Add thread' });
  await expect(createThreadButton).toBeVisible();
  await expect(createThreadButton).toContainText('Thread');
  await expect(createThreadButton.locator('svg')).toBeVisible();

  await page.getByRole('link', { name: 'Open communication thread Initial outreach' }).click();
  const addEntryLink = page.getByRole('link', { name: 'Add entry' });
  await expect(addEntryLink).toBeVisible();
  await expect(addEntryLink).toContainText('Entry');
  await expect(addEntryLink.locator('svg')).toBeVisible();
  await addEntryLink.click();
  await expect(page).toHaveURL(/\/communication-threads\/\d+\/entries\/new$/);
  await page.getByLabel('Direction').selectOption('outbound');
  await page.getByLabel('Content').fill('Hi Katherine, enjoyed meeting you and would love to stay in touch.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Hi Katherine, enjoyed meeting you and would love to stay in touch.')).toBeVisible();

  await page.getByRole('link', { name: 'Entry' }).click();
  await page.getByLabel('Direction').selectOption('note');
  await page.getByLabel('Content').fill('She mentioned she is hiring backend engineers later this quarter.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('She mentioned she is hiring backend engineers later this quarter.')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('li', { hasText: 'She mentioned she is hiring backend engineers later this quarter.' }).getByRole('button', { name: 'Delete entry' }).click();
  await expect(page.getByText('She mentioned she is hiring backend engineers later this quarter.')).not.toBeVisible();
  await expect(page.getByText('Hi Katherine, enjoyed meeting you and would love to stay in touch.')).toBeVisible();

  await page.getByRole('button', { name: 'Close thread' }).click();
  await expect(page.getByRole('button', { name: 'Reopen thread' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close thread' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Reopen thread' }).click();
  await expect(page.getByRole('button', { name: 'Close thread' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen thread' })).toHaveCount(0);
});

test('user can open a person from anywhere on the card', async ({ page }) => {
  const companyName = 'Clickable Card E2E Labs';
  const personName = 'Mary Jackson E2E';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await createPerson(page, {
    fullName: personName,
    title: 'Principal Engineer',
    companyName,
    notes: 'Interested in staying in touch about future roles.',
  });

  const personCard = page.locator('li', { hasText: personName }).first();
  await personCard.click({ position: { x: 40, y: 90 } });

  await expect(page).toHaveURL(/\/people\/\d+$/);
  await expect(page.getByRole('heading', { name: personName })).toBeVisible();
  await expect(page.getByText('Interested in staying in touch about future roles.')).toBeVisible();
});

test('user can add a generated message to the thread', async ({ page }) => {
  const companyName = 'Generated Threads E2E Labs';
  const personName = 'Dorothy Vaughan E2E';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await createPerson(page, {
    fullName: personName,
    companyName,
  });

  await page.locator('li', { hasText: personName }).first().click({ position: { x: 40, y: 40 } });
  await page.getByLabel('Subject').fill('Follow-up');
  await page.getByRole('button', { name: 'Add thread' }).click();

  const threadPath = new URL(page.url()).pathname;
  const response = await page.request.post(`http://127.0.0.1:8081${threadPath}/generated-entry`, {
    form: { generated_message: 'Would love to reconnect next week if you are open to it.' },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto(threadPath);
  await expect(page.getByText('Would love to reconnect next week if you are open to it.')).toBeVisible();
});

test('people card updated timestamp uses latest communication thread last activity', async ({ page }) => {
  const companyName = 'People Timestamp E2E Labs';
  const personName = 'Annie Easley E2E';

  await createCompany(page, {
    name: companyName,
    officialName: companyName,
  });

  await createPerson(page, {
    fullName: personName,
    companyName,
  });

  await page.locator('li', { hasText: personName }).first().click({ position: { x: 40, y: 40 } });
  await page.getByLabel('Subject').fill('Intro');
  await page.getByRole('button', { name: 'Add thread' }).click();
  await page.getByRole('link', { name: 'Entry' }).click();
  await page.getByLabel('Direction').selectOption('outbound');
  await page.getByLabel('Content').fill('Following up with a quick hello.');
  await page.getByRole('button', { name: 'Save' }).click();

  const today = new Date().toISOString().slice(0, 10);
  await page.goto('/people');
  const personCard = page.locator('li', { hasText: personName }).first();
  await expect(personCard).toContainText(`Updated ${today}`);
});