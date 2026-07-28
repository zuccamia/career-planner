import { expect, test, type Page } from '@playwright/test';

// Fresh OPFS per context — the wizard shows on first visit because
// profile_overview.onboarded_at is NULL and every field is empty. The tests
// below either walk the wizard to the flat form or skip out of it early.
//
// The Typst compile path is intentionally not exercised (28 MB WASM cold-
// start would blow the CI timeout budget); resume CRUD is covered without
// clicking Compile.

const gotoProfile = async (page: Page) => {
  await page.goto('/local/profile');
  // The tab strip is only rendered by mountProfile after the DB is up, so it
  // doubles as a "page is live" wait.
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
};

const skipWizardIfPresent = async (page: Page) => {
  // On a fresh DB the wizard shows on Overview. "Skip setup" (visible on
  // steps 1–4) drops straight to the flat form.
  const skip = page.getByRole('button', { name: 'Skip setup' });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
  // Flat form's "About you" card is the marker.
  await expect(page.getByText('About you', { exact: true })).toBeVisible();
};

test.describe('local profile page — wizard', () => {
  test('first visit shows the wizard; walking to recap saves overview fields', async ({ page }) => {
    await gotoProfile(page);

    // Step 1 — Name
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
    await page.locator('#wiz-input').fill('Nova Hoang');
    await page.getByRole('button', { name: /Next/ }).click();

    // Step 2 — Headline
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await page.locator('#wiz-input').fill('Backend engineer, data pipelines');
    await page.getByRole('button', { name: /Next/ }).click();

    // Step 3 — Summary (textarea)
    await expect(page.getByRole('heading', { name: /kind of work do you want/i })).toBeVisible();
    await page.locator('#wiz-input').fill('Six years shipping backend systems.');
    await page.getByRole('button', { name: /Next/ }).click();

    // Step 4 — Skills (pill mode). Fill name/years/level in the input row,
    // click Add, then verify the pill appears before moving on.
    await expect(page.getByRole('heading', { name: 'Your top skills' })).toBeVisible();
    const wizEditor = page.locator('#wiz-skills-editor');
    await wizEditor.locator('.js-skill-name').fill('Go');
    await wizEditor.locator('.js-skill-years').fill('6');
    await wizEditor.locator('.js-skill-level').selectOption('expert');
    await wizEditor.locator('.js-add-skill').click();
    // Expert → emerald palette.
    await expect(wizEditor.locator('.js-skill-pills span[data-skill-index]', { hasText: 'Go' })).toBeVisible();
    await expect(wizEditor.locator('.js-skill-pills .bg-emerald-100')).toHaveCount(1);
    await page.getByRole('button', { name: /Next/ }).click();

    // Themed spark step 5 — pick a chip, then Next.
    await expect(page.getByRole('heading', { name: 'Work environment' })).toBeVisible();
    await page.getByRole('button', { name: '+ remote-friendly' }).click();
    await page.getByRole('button', { name: /Next/ }).click();

    // Skip 6 and 7 to reach the recap fast.
    await page.getByRole('button', { name: 'Skip this' }).click();
    await page.getByRole('button', { name: 'Skip this' }).click();

    // Recap
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
    await expect(page.getByText('Nova Hoang')).toBeVisible();
    await expect(page.getByText('Backend engineer, data pipelines')).toBeVisible();
    // Recap renders skills as "Name (Xy · Level)" — check both the name and
    // the years/level annotation survived the round-trip.
    await expect(page.getByText(/Go \(6y · Expert\)/)).toBeVisible();
    await expect(page.getByText('remote-friendly')).toBeVisible();

    await page.getByRole('button', { name: 'Looks good' }).click();

    // Lands on the flat form; values round-trip.
    await expect(page.getByText('About you', { exact: true })).toBeVisible();
    await expect(page.locator('#ov-name')).toHaveValue('Nova Hoang');
    await expect(page.locator('#ov-headline')).toHaveValue('Backend engineer, data pipelines');
    // Skills editor rendered the Go pill in the expert (emerald) palette.
    const flatPills = page.locator('#ov-skills-editor .js-skill-pills');
    await expect(flatPills.locator('span[data-skill-index]', { hasText: 'Go' })).toBeVisible();
    await expect(flatPills.locator('.bg-emerald-100')).toHaveCount(1);
  });

  test('Skip setup on step 1 opts out entirely and jumps to flat form', async ({ page }) => {
    await gotoProfile(page);
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByText('About you', { exact: true })).toBeVisible();
  });
});

test.describe('local profile page — flat form + sparks', () => {
  test('blur-saves overview fields and adds priority-scoped spark pills', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    // Blur-save on Name: type + tab away.
    await page.locator('#ov-name').fill('Nova Hoang');
    await page.locator('#ov-headline').focus(); // triggers blur on #ov-name

    // Helper: add one spark and wait for its pill to render before proceeding.
    // The Add handler is async (createSpark → rerender) and `.click()` returns
    // as soon as the click event dispatches; without an explicit wait, the
    // next .fill() races with the input reset the handler performs.
    const addSpark = async (body: string, priority: string) => {
      await page.locator('#spark-input').fill(body);
      await page.locator('#spark-priority').selectOption(priority);
      await page.locator('#btn-add-spark').click();
      await expect(page.locator('span[data-spark-id]', { hasText: body })).toBeVisible();
    };

    await addSpark('high-agency team', '1');
    await addSpark('remote-friendly', '1');
    await addSpark('no on-call', '3');

    // The outer pill is a <span>; the × inside is a <button>. Both carry
    // data-spark-id, so selectors count with `span[data-spark-id]` to keep
    // per-pill count accurate.
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(3);
    await expect(page.locator('#sparks-list span[data-spark-id].bg-blue-100')).toHaveCount(2);
    await expect(page.locator('#sparks-list span[data-spark-id].bg-slate-100')).toHaveCount(1);

    // Delete the P3 pill via its × — reduces count, leaves both P1s.
    const slatePill = page.locator('#sparks-list span[data-spark-id].bg-slate-100').first();
    await slatePill.getByRole('button', { name: 'Remove spark' }).click();
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(2);
    await expect(page.locator('#sparks-list span[data-spark-id].bg-slate-100')).toHaveCount(0);

    // Reload → values persist (rules out "only in memory" regressions).
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#ov-name')).toHaveValue('Nova Hoang');
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(2);
  });
});

test.describe('local profile page — resumes tab', () => {
  test('creating a markdown resume updates the tab counter and shows the row', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    // Counter starts hidden (count = 0).
    const resumesTab = page.getByRole('tab', { name: 'Resumes' });
    await expect(resumesTab.locator('[data-tab-count="resumes"]')).toBeHidden();

    await resumesTab.click();
    await page.getByRole('button', { name: 'Add resume' }).click();
    await page.getByLabel('Title').fill('Test resume');
    // Format defaults to Markdown; save.
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toContainText(/Created resume/);

    // Tab counter now shows "1".
    await expect(resumesTab.locator('[data-tab-count="resumes"]')).toHaveText('1');

    // Row visible with title + Markdown badge.
    const row = page.locator('#resume-list li', { hasText: 'Test resume' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Markdown', { exact: true })).toBeVisible();

    // Delete via row × — confirm dialog auto-accepted by the handler.
    page.once('dialog', d => d.accept());
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#toast')).toContainText(/Resume deleted/);
    await expect(resumesTab.locator('[data-tab-count="resumes"]')).toBeHidden();
  });
});

test.describe('local profile page — brag sheet tab', () => {
  test('selected tab persists across refresh via the URL', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    const bragTab = page.getByRole('tab', { name: 'Brag Sheet' });
    await bragTab.click();

    await expect(page).toHaveURL(/\/local\/profile\?tab=brag$/);
    await expect(page.getByRole('button', { name: 'Add brag entry' })).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/local\/profile\?tab=brag$/);
    await expect(page.getByRole('tab', { name: 'Brag Sheet', selected: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add brag entry' })).toBeVisible();
  });

  test('creating a brag entry with impact renders the impact line and increments the counter', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    const bragTab = page.getByRole('tab', { name: 'Brag Sheet' });
    await expect(bragTab.locator('[data-tab-count="brag"]')).toBeHidden();

    await bragTab.click();
    await page.getByRole('button', { name: 'Add brag entry' }).click();

    await page.getByLabel('Title').fill('Shipped incident-detection MVP');
    await page.getByLabel('Description').fill('Rolled out behind a feature flag.');
    await page.getByLabel(/Impact/).fill('Cut MTTD from 22 min to under 4 min');
    await page.getByLabel('Tags').fill('reliability');
    await page.locator('#btn-add-brag-tag').click();
    await page.getByLabel('Tags').fill('ownership');
    await page.locator('#btn-add-brag-tag').click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toContainText(/Created brag/);

    await expect(bragTab.locator('[data-tab-count="brag"]')).toHaveText('1');

    const row = page.locator('#brag-list li', { hasText: 'Shipped incident-detection MVP' });
    await expect(row).toBeVisible();
    // The "Impact:" prefixed line — proof the impact column survives the
    // round-trip and renders separately from body.
    await expect(row.getByText('Impact: Cut MTTD from 22 min to under 4 min')).toBeVisible();
    await expect(row.getByText('reliability', { exact: true })).toBeVisible();
    await expect(row.getByText('ownership', { exact: true })).toBeVisible();
  });

  test('editing a brag entry updates impact and manual tags', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    const bragTab = page.getByRole('tab', { name: 'Brag Sheet' });
    await bragTab.click();
    await page.getByRole('button', { name: 'Add brag entry' }).click();

    await page.getByLabel('Title').fill('Stabilized ETL pipeline');
    await page.getByLabel('Description').fill('Reduced noisy alerts during batch windows.');
    await page.getByLabel('Tags').fill('operations');
    await page.locator('#btn-add-brag-tag').click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toContainText(/Created brag/);

    let row = page.locator('#brag-list li', { hasText: 'Stabilized ETL pipeline' });
    await expect(row).toBeVisible();
    await expect(row.getByText('operations', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Edit brag entry')).toBeVisible();

    await page.getByLabel('Title').fill('Stabilized ETL pipeline v2');
    await page.getByLabel(/Impact/).fill('Cut false-positive pages by 80%');
    await page.locator('#brag-tags-list').getByRole('button', { name: 'Remove tag' }).click();
    await page.getByLabel('Tags').fill('reliability');
    await page.locator('#btn-add-brag-tag').click();
    await page.getByLabel('Tags').fill('observability');
    await page.locator('#btn-add-brag-tag').click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toContainText('Brag entry saved');

    row = page.locator('#brag-list li', { hasText: 'Stabilized ETL pipeline v2' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Impact: Cut false-positive pages by 80%')).toBeVisible();
    await expect(row.getByText('reliability', { exact: true })).toBeVisible();
    await expect(row.getByText('observability', { exact: true })).toBeVisible();
    await expect(row.getByText('operations', { exact: true })).toHaveCount(0);
  });
});
