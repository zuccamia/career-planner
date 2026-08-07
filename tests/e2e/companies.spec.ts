import { expect, test, type Page } from '@playwright/test';

// The app renders entirely on the client: the Go server only
// serves a minimal HTML shell, and page content is drawn by JS after
// sqlite-wasm + OPFS boot. Each Playwright test uses a fresh browser context,
// so OPFS starts empty and no server-side reset is required.

const gotoCompanies = async (page: Page, query = '') => {
  await page.goto(`/companies${query}`);
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
    blogURL?: string;
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
  if (values.blogURL !== undefined) {
    await page.getByLabel('Blog / insights URL').fill(values.blogURL);
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
      blogURL: 'https://stripe.com/blog/engineering',
      atsURL: 'https://stripe.com/jobs',
      atsProvider: 'Greenhouse',
    });
    await page.getByRole('button', { name: 'Create company' }).click();

    // Toast + list update.
    await expect(page.locator('#toast')).toContainText(/Created company #\d+/);
    await expect(page.getByText('No companies yet.')).toHaveCount(0);
    const card = page.locator('#list-content li', { hasText: 'Stripe Local Co.' });
    await expect(card).toBeVisible();
    // Row is a button whose accessible name opens the file (dossier slide-over).
    await expect(card.getByRole('button', { name: /Open Stripe Local Co\./ })).toBeVisible();
    // Page count line reflects state.
    await expect(page.locator('#companies-count')).toHaveText(/1 company tracked\./);

    // Edit lives in the slide-over — open the row, then click Edit; the form
    // renders in-place inside the same panel.
    await card.getByRole('button', { name: /Open Stripe Local Co\./ }).click();
    const dossier = page.locator('#dossier-panel');
    await dossier.getByRole('button', { name: 'Edit company' }).click();
    await expect(dossier.getByText('Edit', { exact: true })).toBeVisible();
    await fillEditor(page, { officialName: 'Stripe Local Co. Updated', atsProvider: 'Ashby' });
    await dossier.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#toast')).toContainText('Company saved');
    await expect(
      page.locator('#list-content li', { hasText: 'Stripe Local Co. Updated' }),
    ).toBeVisible();

    // After save the slide-over stays open in view mode — delete from there.
    page.once('dialog', (dialog) => dialog.accept());
    await dossier.getByRole('button', { name: /^Delete Stripe Local Co\. Updated$/ }).click();
    await expect(page.locator('#toast')).toContainText('Company deleted');
    await expect(page.getByText('No companies yet.')).toBeVisible();
  });

  // Regression: buildDossier's caller in pages/companies.mjs used to omit
  // blog_url from the payload, so the server never saw the blog URL and
  // scrapeMissingIntoEnrichment skipped the blog fanout. This pins that the
  // outgoing /api/dossiers/build body includes blog_url exactly as saved.
  test('Build dossier forwards blog_url in the request payload', async ({ page }) => {
    // Force server-LLM path so buildDossier hits /api/dossiers/build (BYOK
    // would route through /api/llm/prompts/build-dossier — same bug lived
    // in the shared caller, so covering either path catches it).
    await page.route('**/api/llm/server-status', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, provider: 'openai-compatible', model: 'gpt-4o-mini' }) }),
    );
    let capturedBody: Record<string, unknown> = {};
    await page.route('**/api/dossiers/build', async (route) => {
      try { capturedBody = JSON.parse(route.request().postData() || '{}'); } catch { /* ignore */ }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          company_summary: 'stub summary',
          product: '', customers: '', tech_stack: '', culture_notes: '',
          careers_url: '', ats_provider: '', hiring_signals: [], reasoning: '',
        }),
      });
    });

    await gotoCompanies(page);
    await openEditor(page);
    await fillEditor(page, {
      officialName: 'Blog Test Co.',
      website: 'https://blogtest.example',
      blogURL: 'https://blogtest.example/engineering',
    });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#toast')).toContainText(/Created company/);

    const card = page.locator('#list-content li', { hasText: 'Blog Test Co.' });
    await card.getByRole('button', { name: /Open Blog Test Co\./ }).click();
    await page.locator('#btn-dossier-build').click();
    // Wait for the build call to resolve — the success note appears only
    // after the intercepted response is processed.
    await expect(page.locator('#dossier-note')).toContainText(/Dossier built/);

    // The regression: blog_url must be forwarded intact.
    expect(capturedBody.blog_url).toBe('https://blogtest.example/engineering');
    // Sanity check that the payload is otherwise well-formed.
    expect(capturedBody.official_name).toBe('Blog Test Co.');
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

  test('top-bar quick-action link opens the editor', async ({ page }) => {
    await gotoCompanies(page);
    // Top-bar "Add company" quick action — layout renders relative hrefs
    // so nav works under both root and project-page deploys.
    await page.locator('a[href="companies?new=1"]').click();
    await expect(page.getByText('New company')).toBeVisible();
  });

  test('row meta reflects per-company application counts', async ({ page }) => {
    // Seed two companies; only Alpha gets an application, so we can assert
    // per-company role counts are independent (not global).
    await gotoCompanies(page);
    await openEditor(page);
    await fillEditor(page, { officialName: 'Alpha Co.' });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#list-content li', { hasText: 'Alpha Co.' })).toBeVisible();

    await openEditor(page);
    await fillEditor(page, { officialName: 'Beta Co.' });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#list-content li', { hasText: 'Beta Co.' })).toBeVisible();

    await page.goto('/applications?new=1');
    await expect(page.getByText('New application')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Company', { exact: true }).selectOption({ label: 'Alpha Co.' });
    await page.getByLabel('Role').fill('Analytical Engineer');
    await page.getByRole('button', { name: 'Create application' }).click();
    await expect(page.locator('#toast')).toContainText(/Created application/);

    await gotoCompanies(page);
    const alphaCard = page.locator('#list-content li', { hasText: 'Alpha Co.' });
    const betaCard = page.locator('#list-content li', { hasText: 'Beta Co.' });
    await expect(alphaCard).toContainText('1 role');
    await expect(betaCard).toContainText('0 roles');
  });

  // A company name with special characters should render as literal text
  // (no HTML injection) and appear correctly in confirm dialogs (no visible
  // &amp; leaks).
  test('special characters in a company name render safely across the UI', async ({ page }) => {
    const trickyName = 'Rock & <b>Roll</b> "Inc"';
    await gotoCompanies(page);
    await openEditor(page);
    await fillEditor(page, { officialName: trickyName });
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.locator('#toast')).toContainText(/Created company #\d+/);

    // innerHTML sink: the list card must render the name as literal text —
    // if <b> parsed as HTML, no <b> element would exist inside the card and
    // toContainText would still match. So assert both: text matches AND
    // there is no actual <b> descendant (proves the tags stayed as text).
    const card = page.locator('#list-content li', { hasText: trickyName });
    await expect(card).toBeVisible();
    await expect(card).toContainText(trickyName);
    await expect(card.locator('b')).toHaveCount(0);
    // Double-escape guard: literal "&amp;" must never appear as visible text.
    await expect(card).not.toContainText('&amp;');

    // Delete lives in the dossier slide-over — open the row first.
    await card.getByRole('button', { name: new RegExp(`Open ${trickyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
    const panel = page.locator('#dossier-panel');
    await expect(panel).toBeVisible();

    // confirm dialog: message contains the raw &, <, >, " — not &amp;, &lt;,
    // &gt;, &quot;. Capture the dialog text before dismissing.
    const dialogText = await new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        const msg = dialog.message();
        dialog.dismiss();
        resolve(msg);
      });
      panel.getByRole('button', { name: `Delete ${trickyName}` }).click();
    });
    expect(dialogText).toContain(trickyName);
    expect(dialogText).not.toContain('&amp;');
    expect(dialogText).not.toContain('&lt;');
    expect(dialogText).not.toContain('&quot;');
  });
});
