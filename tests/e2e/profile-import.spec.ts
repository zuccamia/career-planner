import { expect, test, type Page } from '@playwright/test';

// The Import flow is launched from the Profile page's header button. It
// replaces the tab-content area, so no separate route to visit. This spec
// covers the wiring — button click, view swap, back navigation, URL round-
// trip — without exercising the real wasm extraction path (that boots a
// 5 MB liteparse WASM and is best covered by manual smoke or a dedicated
// slow-suite spec later).

const gotoProfile = async (page: Page) => {
  await page.goto('/profile');
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
};

const skipWizardIfPresent = async (page: Page) => {
  for (const label of ['Skip setup', 'Skip this']) {
    const btn = page.getByRole('button', { name: label });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
    }
  }
};

test.describe('profile import', () => {
  test('opens the import view when the header button is clicked', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    await page.getByRole('button', { name: 'Import from file' }).click();

    // Import view surface: choose-file button + page title.
    await expect(page.getByRole('heading', { name: 'Import résumé or brag sheet' })).toBeVisible();
    await expect(page.getByText('Choose file')).toBeVisible();
    // Tab strip remains but no tab is highlighted (import isn't in the strip).
    await expect(page).toHaveURL(/[?&]tab=import\b/);
  });

  test('Back returns to the overview tab and drops ?tab=import', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);
    await page.getByRole('button', { name: 'Import from file' }).click();
    await expect(page).toHaveURL(/[?&]tab=import\b/);

    await page.getByRole('button', { name: 'Back to profile' }).click();

    // Overview tab is re-rendered; the URL loses the tab param.
    await expect(page.getByRole('tab', { name: 'Overview', selected: true })).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]tab=import\b/);
  });

  test('import view survives a page refresh via ?tab=import', async ({ page }) => {
    await page.goto('/profile?tab=import');
    // Skip wizard doesn't fire — the flow enters import mode straight from URL.
    await expect(page.getByText('Choose file')).toBeVisible({ timeout: 30_000 });
  });

  test('rejects a non-PDF/DOCX file with a clear error', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);
    await page.getByRole('button', { name: 'Import from file' }).click();

    // Set a plain-text buffer that fails the magic-byte sniff.
    await page.getByLabel('Choose file').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not a pdf or docx'),
    });

    await expect(page.getByText(/Unsupported file type/i)).toBeVisible();
    // Result panel stays hidden.
    await expect(page.locator('#ri-result')).toBeHidden();
  });

  test('Build Typst résumé opens the preview panel with source populated', async ({ page }) => {
    // Stub the LLM-availability probe so the client will attempt the
    // extract call instead of bailing with "AI not configured".
    await page.route('**/api/llm/server-status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ available: true, provider: 'stub', model: 'stub' }) }),
    );

    // Stub the structured-résumé extraction endpoint with a canned payload.
    // The renderer must produce Typst source containing these strings.
    const canned = {
      contact: { name: 'Ada Lovelace', email: 'ada@example.com', location: 'London' },
      education: [{ school: 'Analytical Engine Institute', degree: 'MS Computing', dates: '1843' }],
      experience: [{ company: 'Difference Engine Co', title: 'Programmer',
        bullets: [{ lead_in: 'Notes', description: 'Wrote the first algorithm.' }] }],
    };
    await page.route('**/api/profile/extract-structured-resume-from-md', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(canned) }),
    );

    await gotoProfile(page);
    await skipWizardIfPresent(page);
    await page.getByRole('button', { name: 'Import from file' }).click();

    // Populate the Markdown textarea directly — bypasses the wasm extraction
    // path since we're testing the Typst build flow, not liteparse.
    await page.locator('#ri-result').evaluate((el) => el.classList.remove('hidden'));
    await page.locator('#ri-markdown').fill('# Ada Lovelace\n\nEngineer.\n');

    await page.getByRole('button', { name: 'Build Typst résumé' }).click();

    // The review panel appears; the source textarea contains the house
    // preamble plus canned content the LLM stub returned.
    const source = page.locator('#ri-typst-source');
    await expect(source).toBeVisible({ timeout: 15_000 });
    const value = await source.inputValue();
    expect(value).toContain('#set page(paper: "us-letter"');
    expect(value).toContain('Ada Lovelace');
    expect(value).toContain('Analytical Engine Institute');
    expect(value).toContain('Difference Engine Co');
    // Save button surfaces alongside; we don't click it (would trigger a
    // real Typst compile of the source, blowing the CI wasm budget).
    await expect(page.getByRole('button', { name: 'Save to résumés' })).toBeVisible();
  });
});
