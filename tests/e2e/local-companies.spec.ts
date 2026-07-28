import { expect, test, type Page } from '@playwright/test';

// The local-first app renders entirely on the client: the Go server only
// serves a minimal HTML shell, and page content is drawn by JS after
// sqlite-wasm + OPFS boot. Each Playwright test uses a fresh browser context,
// so OPFS starts empty and no server-side reset is required.

const gotoCompanies = async (page: Page, query = '') => {
  await page.goto(`/local/companies${query}`);
  // pageHeader renders the "Companies" eyebrow once boot completes.
  await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 30_000 });
};

const openEditor = async (page: Page) => {
  await page.getByRole('button', { name: 'Add company' }).click();
  await expect(page.getByText('New company')).toBeVisible();
};

const fillEditor = async (
  page: Page,
  values: {
    officialName?: string;
    website?: string;
    techBlogURL?: string;
    atsURL?: string;
    atsProvider?: string;
  },
) => {
  if (values.officialName !== undefined) {
    await page.getByLabel('Official name').fill(values.officialName);
  }
  if (values.website !== undefined) {
    await page.getByLabel('Website').fill(values.website);
  }
  if (values.techBlogURL !== undefined) {
    await page.getByLabel('Tech blog URL').fill(values.techBlogURL);
  }
  if (values.atsURL !== undefined) {
    await page.getByLabel('ATS URL').fill(values.atsURL);
  }
  if (values.atsProvider !== undefined) {
    await page.getByLabel('ATS provider').fill(values.atsProvider);
  }
};

test.describe('local companies page', () => {
  test('renders empty state before any companies exist', async ({ page }) => {
    await gotoCompanies(page);
    await expect(page.getByText('No companies yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add company' })).toBeVisible();
  });

  test('user can create, edit, and delete a company', async ({ page }) => {
    await gotoCompanies(page);
    await openEditor(page);

    await fillEditor(page, {
      officialName: 'Stripe Local Co.',
      website: 'https://stripe.com',
      techBlogURL: 'https://stripe.com/blog/engineering',
      atsURL: 'https://stripe.com/jobs',
      atsProvider: 'Greenhouse',
    });
    await page.getByRole('button', { name: 'Create company' }).click();

    // Toast + list update.
    await expect(page.locator('#toast')).toContainText(/Created company #\d+/);
    await expect(page.getByText('No companies yet.')).toHaveCount(0);
    const card = page.locator('#list-content li', { hasText: 'Stripe Local Co.' });
    await expect(card).toBeVisible();
    // Name links to website when website is set.
    await expect(card.getByRole('link', { name: 'Stripe Local Co.' })).toHaveAttribute(
      'href',
      /https:\/\/stripe\.com\/?$/,
    );
    // Tech blog icon-link renders when tech_blog_url is set.
    await expect(card.getByRole('link', { name: 'Tech blog' })).toBeVisible();
    // Page count line reflects state.
    await expect(page.locator('#companies-count')).toHaveText(/1 company tracked locally\./);

    // Edit: update name + provider.
    await card.getByRole('button', { name: 'Edit company' }).click();
    await expect(page.locator('#editor-panel').getByText('Edit', { exact: true })).toBeVisible();
    await fillEditor(page, { officialName: 'Stripe Local Co. Updated', atsProvider: 'Ashby' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#toast')).toContainText('Company saved');
    await expect(
      page.locator('#list-content li', { hasText: 'Stripe Local Co. Updated' }),
    ).toBeVisible();

    // Delete: confirms then removes from the list.
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator('#list-content li', { hasText: 'Stripe Local Co. Updated' })
      .getByRole('button', { name: /^Delete Stripe Local Co\. Updated$/ })
      .click();
    await expect(page.locator('#toast')).toContainText('Company deleted');
    await expect(page.getByText('No companies yet.')).toBeVisible();
  });

  test('editor cancel button closes the panel without saving', async ({ page }) => {
    await gotoCompanies(page);
    await openEditor(page);
    await fillEditor(page, { officialName: 'Discarded Co.' });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('New company')).toHaveCount(0);
    await expect(page.getByText('No companies yet.')).toBeVisible();
  });

  test('duplicate company name is blocked with an inline error', async ({ page }) => {
    await gotoCompanies(page);

    await openEditor(page);
    await fillEditor(page, { officialName: 'Linear' });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#toast')).toContainText(/Created company #\d+/);

    await openEditor(page);
    // Case-insensitive check on the client, so lowercase collides with "Linear".
    await fillEditor(page, { officialName: 'linear' });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#editor-error')).toBeVisible();
    await expect(page.locator('#editor-error')).toContainText(/already exists/);
    // Still only one row.
    await expect(page.locator('#list-content li')).toHaveCount(1);
  });

  test('empty official name shows an inline error at the top of the editor', async ({ page }) => {
    await gotoCompanies(page);
    await openEditor(page);
    // Bypass the native required attribute by submitting the form directly.
    await page.locator('#editor-form').evaluate((form: HTMLFormElement) => {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await expect(page.locator('#editor-error')).toBeVisible();
    await expect(page.locator('#editor-error')).toContainText('Official name is required');
  });

  test('?new=1 auto-opens the editor', async ({ page }) => {
    await gotoCompanies(page, '?new=1');
    await expect(page.getByText('New company')).toBeVisible();
    await expect(page.getByLabel('Official name')).toBeFocused();
  });

  test('sidebar quick-action link opens the editor', async ({ page }) => {
    await gotoCompanies(page);
    // Sidebar "Add company" quick action links to /local/companies?new=1.
    await page.locator('a[href="/local/companies?new=1"]').click();
    await expect(page.getByText('New company')).toBeVisible();
  });

  test('count pills reflect related rows and link to filtered pages', async ({ page }) => {
    // Seed two companies; only company A gets a person + application so we can
    // assert per-company counts are independent (not global).
    await gotoCompanies(page);
    await openEditor(page);
    await fillEditor(page, { officialName: 'Alpha Co.' });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#list-content li', { hasText: 'Alpha Co.' })).toBeVisible();

    await openEditor(page);
    await fillEditor(page, { officialName: 'Beta Co.' });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#list-content li', { hasText: 'Beta Co.' })).toBeVisible();

    // One person + one application, both attached to Alpha Co.
    await page.goto('/local/people?new=1');
    await expect(page.getByText('New person')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Company', { exact: true }).selectOption({ label: 'Alpha Co.' });
    await page.getByRole('button', { name: 'Create person' }).click();
    await expect(page.locator('#toast')).toContainText(/Created person/);

    await page.goto('/local/applications?new=1');
    await expect(page.getByText('New application')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Company', { exact: true }).selectOption({ label: 'Alpha Co.' });
    await page.getByLabel('Role').fill('Analytical Engineer');
    await page.getByRole('button', { name: 'Create application' }).click();
    await expect(page.locator('#toast')).toContainText(/Created application/);

    await gotoCompanies(page);
    const alphaCard = page.locator('#list-content li', { hasText: 'Alpha Co.' });
    const betaCard = page.locator('#list-content li', { hasText: 'Beta Co.' });

    // The linked pills expose their destination through the title attribute —
    // the badge span itself carries the count text.
    const alphaPeoplePill = alphaCard.getByTitle('People at Alpha Co.');
    const alphaAppsPill = alphaCard.getByTitle('Applications at Alpha Co.');
    await expect(alphaPeoplePill).toHaveAttribute('href', /\/local\/people\?company_id=\d+$/);
    await expect(alphaAppsPill).toHaveAttribute('href', /\/local\/applications\?company_id=\d+$/);
    await expect(alphaPeoplePill).toContainText('1');
    await expect(alphaAppsPill).toContainText('1');

    // Beta has no related rows — pills still render but show 0.
    await expect(betaCard.getByTitle('People at Beta Co.')).toContainText('0');
    await expect(betaCard.getByTitle('Applications at Beta Co.')).toContainText('0');

    // Engineering-blog pill is inert (no local page yet). The header row
    // should therefore only expose two anchor pills — the ones we titled
    // above — plus no unrelated blog link.
    const headerAnchors = alphaCard.locator('a[title^="People at "], a[title^="Applications at "], a[title^="Engineering blog"]');
    await expect(headerAnchors).toHaveCount(2);
  });
});
