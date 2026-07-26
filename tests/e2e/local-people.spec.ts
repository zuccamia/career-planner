import { expect, test, type Page } from '@playwright/test';

// Same context-isolation model as local-companies.spec.ts — each test starts
// with a fresh OPFS, so no server-side reset is needed. LLM buttons
// (Summarize / Draft outreach / Draft reply) are not exercised: they require
// a live LLM which the test env has disabled.

const gotoPeople = async (page: Page, query = '') => {
  await page.goto(`/local/people${query}`);
  await expect(page.getByText('People', { exact: true })).toBeVisible({ timeout: 30_000 });
};

const openEditor = async (page: Page) => {
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByText('New person')).toBeVisible();
};

const createPerson = async (
  page: Page,
  values: { fullName: string; title?: string; linkedIn?: string; notes?: string },
) => {
  await openEditor(page);
  await page.getByLabel('Full name').fill(values.fullName);
  if (values.title !== undefined) await page.getByLabel('Title').fill(values.title);
  if (values.linkedIn !== undefined) await page.getByLabel('LinkedIn URL').fill(values.linkedIn);
  if (values.notes !== undefined) await page.getByLabel('Notes').fill(values.notes);
  await page.getByRole('button', { name: 'Create person' }).click();
  await expect(page.locator('#toast')).toContainText(/Created person #\d+/);
};

test.describe('local people page', () => {
  test('renders empty state', async ({ page }) => {
    await gotoPeople(page);
    await expect(page.getByText('No people yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add person' })).toBeVisible();
  });

  test('create, edit, and delete a person', async ({ page }) => {
    await gotoPeople(page);
    await createPerson(page, {
      fullName: 'Ada Lovelace',
      title: 'Analytical Engineer',
      linkedIn: 'https://linkedin.com/in/ada',
      notes: 'Met at a conference; interested in intern program.',
    });

    const card = page.locator('#list-content li', { hasText: 'Ada Lovelace' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Analytical Engineer');
    await expect(card.getByRole('link', { name: 'LinkedIn' })).toHaveAttribute(
      'href',
      'https://linkedin.com/in/ada',
    );

    // Edit
    await card.getByRole('button', { name: 'Edit person' }).click();
    await expect(page.locator('#editor-panel').getByText('Edit', { exact: true })).toBeVisible();
    await page.getByLabel('Title').fill('Software Engineer');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#toast')).toContainText('Person saved');
    await expect(
      page.locator('#list-content li', { hasText: 'Ada Lovelace' }),
    ).toContainText('Software Engineer');

    // Delete
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator('#list-content li', { hasText: 'Ada Lovelace' })
      .getByRole('button', { name: /^Delete Ada Lovelace$/ })
      .click();
    await expect(page.locator('#toast')).toContainText('Person deleted');
    await expect(page.getByText('No people yet.')).toBeVisible();
  });

  test('duplicate name is blocked with an inline error', async ({ page }) => {
    await gotoPeople(page);
    await createPerson(page, { fullName: 'Grace Hopper' });

    await openEditor(page);
    await page.getByLabel('Full name').fill('grace hopper');
    await page.getByRole('button', { name: 'Create person' }).click();
    await expect(page.locator('#editor-error')).toBeVisible();
    await expect(page.locator('#editor-error')).toContainText(/already exists/);
    await expect(page.locator('#list-content li')).toHaveCount(1);
  });

  test('threads panel: create thread, add entry, close+reopen, delete', async ({ page }) => {
    await gotoPeople(page);
    await createPerson(page, { fullName: 'Alan Turing', notes: 'Halting problem person.' });

    const card = page.locator('#list-content li', { hasText: 'Alan Turing' });
    await card.getByRole('button', { name: 'Threads' }).click();
    await expect(page.getByText(/Threads — Alan Turing/)).toBeVisible();
    await expect(page.getByText('No threads yet.')).toBeVisible();

    // Create thread
    await page.getByRole('button', { name: 'Add thread' }).click();
    await page.getByLabel('Subject').fill('Intro chat');
    await page.getByLabel('Channel').selectOption('email');
    // Icon-only submit — aria-label is "Create thread".
    await page.getByRole('button', { name: 'Create thread', exact: true }).click();
    await expect(page.locator('#toast')).toContainText(/Thread #\d+ created/);
    const threadCard = page.locator('#thread-list li', { hasText: 'Intro chat' });
    await expect(threadCard).toBeVisible();
    // email/handshake/linkedin render as brand icons; check by accessible name.
    await expect(threadCard.getByLabel('Email')).toBeVisible();
    await expect(threadCard).toContainText('Open');

    // Thread auto-expands after create; open the entry form and add one.
    await page.getByRole('button', { name: 'Add entry' }).click();
    await page.getByLabel('Direction').selectOption('outbound');
    await page.getByLabel('Content').fill('Sent an initial outreach note.');
    await page.getByRole('button', { name: 'Create entry' }).click();
    await expect(page.locator('#toast')).toContainText('Entry added');
    await expect(page.getByText('Sent an initial outreach note.')).toBeVisible();

    // Close thread
    await threadCard.getByRole('button', { name: 'Close thread' }).click();
    await expect(page.locator('#toast')).toContainText('Thread closed');
    await expect(page.locator('#thread-list li', { hasText: 'Intro chat' })).toContainText('Closed');

    // Reopen
    await page
      .locator('#thread-list li', { hasText: 'Intro chat' })
      .getByRole('button', { name: 'Reopen thread' })
      .click();
    await expect(page.locator('#toast')).toContainText('Thread open');

    // Delete thread
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator('#thread-list li', { hasText: 'Intro chat' })
      .getByRole('button', { name: /^Delete thread Intro chat$/ })
      .click();
    await expect(page.locator('#toast')).toContainText('Thread deleted');
    await expect(page.getByText('No threads yet.')).toBeVisible();

    // Back on the list, thread count badge should be gone (0 threads).
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#list-content li', { hasText: 'Alan Turing' })).not.toContainText('thread');
  });

  test('?new=1 auto-opens the editor', async ({ page }) => {
    await gotoPeople(page, '?new=1');
    await expect(page.getByText('New person')).toBeVisible();
    await expect(page.getByLabel('Full name')).toBeFocused();
  });

  test('?company_id=… filters the list and Clear link restores it', async ({ page }) => {
    // Seed two companies + two people (one per company) so we can verify the
    // filter narrows the list to just the requested company.
    await page.goto('/local/companies');
    await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const name of ['Alpha Co.', 'Beta Co.']) {
      await page.getByRole('button', { name: 'Add company' }).click();
      await page.getByLabel('Official name').fill(name);
      await page.getByRole('button', { name: 'Create company' }).click();
      await expect(page.locator('#list-content li', { hasText: name })).toBeVisible();
    }

    await gotoPeople(page);
    await createPerson(page, { fullName: 'Ada Alpha' });
    // Attach Ada to Alpha Co. via the edit form (createPerson doesn't set it).
    await page.locator('#list-content li', { hasText: 'Ada Alpha' })
      .getByRole('button', { name: 'Edit person' }).click();
    await page.getByLabel('Company', { exact: true }).selectOption({ label: 'Alpha Co.' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#toast')).toContainText('Person saved');

    await createPerson(page, { fullName: 'Bob Beta' });
    await page.locator('#list-content li', { hasText: 'Bob Beta' })
      .getByRole('button', { name: 'Edit person' }).click();
    await page.getByLabel('Company', { exact: true }).selectOption({ label: 'Beta Co.' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#toast')).toContainText('Person saved');

    // Jump in via the companies page — click Alpha's people pill so we exercise
    // the same navigation the user would.
    await page.goto('/local/companies');
    await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.locator('#list-content li', { hasText: 'Alpha Co.' })
      .getByTitle('People at Alpha Co.').click();

    // Banner shows the filter, count copy is company-scoped, and only Ada
    // remains in the list.
    await expect(page).toHaveURL(/\/local\/people\?company_id=\d+$/);
    await expect(page.getByText('Filtered by company:')).toBeVisible();
    await expect(page.locator('#people-count')).toHaveText(/1 person at Alpha Co\./);
    await expect(page.locator('#list-content li')).toHaveCount(1);
    await expect(page.locator('#list-content li', { hasText: 'Ada Alpha' })).toBeVisible();

    // Clear the filter — banner disappears, both rows come back.
    await page.getByRole('link', { name: 'Clear filter' }).click();
    await expect(page).toHaveURL(/\/local\/people$/);
    await expect(page.getByText('Filtered by company:')).toHaveCount(0);
    await expect(page.locator('#list-content li')).toHaveCount(2);
  });

  test('?company_id=… with an unknown id falls back to the full list with a warning', async ({ page }) => {
    await gotoPeople(page);
    await createPerson(page, { fullName: 'Grace Hopper' });

    await gotoPeople(page, '?company_id=99999');
    await expect(page.locator('#toast')).toContainText(/Company #99999 not found/);
    await expect(page.getByText('Filtered by company:')).toHaveCount(0);
    await expect(page.locator('#list-content li', { hasText: 'Grace Hopper' })).toBeVisible();
  });
});
