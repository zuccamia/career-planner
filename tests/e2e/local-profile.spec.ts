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
  // On a fresh DB the wizard shows on Overview. Step 1's Skip button reads
  // "Skip setup" when the name field is empty and "Skip this" once anything
  // is typed — click whichever is currently visible.
  for (const label of ['Skip setup', 'Skip this']) {
    const btn = page.getByRole('button', { name: label });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      break;
    }
  }
  // Flat form's "About you" card is the marker.
  await expect(page.getByText('About you', { exact: true })).toBeVisible();
};

// Wizard tests moved to local-profile-wizard.spec.ts.

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
    await expect(page.locator('#sparks-list span[data-spark-id].bg-brand-tint')).toHaveCount(2);
    await expect(page.locator('#sparks-list span[data-spark-id].bg-status-hold-bg')).toHaveCount(1);

    // Delete the P3 pill via its × — reduces count, leaves both P1s.
    const slatePill = page.locator('#sparks-list span[data-spark-id].bg-status-hold-bg').first();
    await slatePill.getByRole('button', { name: 'Remove spark' }).click();
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(2);
    await expect(page.locator('#sparks-list span[data-spark-id].bg-status-hold-bg')).toHaveCount(0);

    // Reload → values persist (rules out "only in memory" regressions).
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#ov-name')).toHaveValue('Nova Hoang');
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(2);
  });

  test('flat form skills editor adds and persists a skill', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    const editor = page.locator('#ov-skills-editor');
    await editor.locator('.js-skill-name').fill('Python');
    await editor.locator('.js-skill-years').fill('4');
    await editor.locator('.js-skill-level').selectOption('advanced');
    await editor.locator('.js-add-skill').click();

    // Pill renders in the advanced (brand) palette.
    await expect(editor.locator('.js-skill-pills span[data-skill-index]', { hasText: 'Python' })).toBeVisible();
    await expect(editor.locator('.js-skill-pills .bg-brand-tint')).toHaveCount(1);

    // Reload → persisted.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#ov-skills-editor .js-skill-pills span[data-skill-index]', { hasText: 'Python' })).toBeVisible();
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
    // New résumés default to Typst format; save.
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toContainText(/Created resume/);
    // Close the slide-over so the list refreshes with the new row + count.
    await page.locator('#btn-resume-close').click();

    // Tab counter now shows "1".
    await expect(resumesTab.locator('[data-tab-count="resumes"]')).toHaveText('1');

    // Row visible with title + Typst badge.
    const row = page.locator('#resume-list li', { hasText: 'Test resume' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Typst', { exact: true })).toBeVisible();

    // Delete lives inside the slide-over header now — reopen the panel and
    // click the trash button there.
    await row.locator('.js-open-resume').click();
    page.once('dialog', d => d.accept());
    await page.locator('#btn-resume-delete').click();
    await expect(page.locator('#toast')).toContainText(/Resume deleted/);
    await expect(resumesTab.locator('[data-tab-count="resumes"]')).toBeHidden();
  });
});

test.describe('local profile page — brag sheet tab', () => {
  test('selected tab persists across refresh via the URL', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    const bragTab = page.getByRole('tab', { name: 'Brags' });
    await bragTab.click();

    await expect(page).toHaveURL(/\/local\/profile\?tab=brag$/);
    await expect(page.getByRole('button', { name: 'Add brag entry' })).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/local\/profile\?tab=brag$/);
    await expect(page.getByRole('tab', { name: 'Brags', selected: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add brag entry' })).toBeVisible();
  });

  test('creating a brag entry with impact renders the impact line and increments the counter', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);

    const bragTab = page.getByRole('tab', { name: 'Brags' });
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

    const bragTab = page.getByRole('tab', { name: 'Brags' });
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
