import { expect, test, type Page } from '@playwright/test';

// Fresh OPFS per context — the 7-step wizard shows on first visit because
// profile_overview.onboarded_at is NULL and every field is empty.

const gotoProfile = async (page: Page) => {
  await page.goto('/profile');
  // The tab strip is only rendered by mountProfile after the DB is up, so it
  // doubles as a "page is live" wait.
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
};

test.describe('local profile page — wizard', () => {
  test('happy path walks all 7 steps, lands on Profile ready, then flat form has the values', async ({ page }) => {
    await gotoProfile(page);

    // Step 1 — name (required)
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
    // Back is rendered but disabled on step 1 (spec: keep the slot to prevent layout shift).
    await expect(page.locator('#btn-wizard-back')).toBeDisabled();
    // Next is disabled until the required field is satisfied.
    await expect(page.locator('#btn-wizard-next')).toBeDisabled();
    await page.locator('#wiz-input').fill('Nova Hoang');
    await expect(page.locator('#btn-wizard-next')).toBeEnabled();
    await page.locator('#btn-wizard-next').click();

    // Step 2 — pitch (optional)
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await page.locator('#wiz-input').fill('Backend engineer, data pipelines');
    await page.locator('#btn-wizard-next').click();

    // Step 3 — direction (required, textarea)
    await expect(page.getByRole('heading', { name: /kind of work do you want/i })).toBeVisible();
    await expect(page.locator('#btn-wizard-next')).toBeDisabled();
    await page.locator('#wiz-input').fill('Six years shipping backend systems.');
    await page.locator('#btn-wizard-next').click();

    // Step 4 — values (multi-select, max 3 → P1 sparks)
    await expect(page.getByRole('heading', { name: 'What matters most?' })).toBeVisible();
    await page.locator('.js-value-chip[data-value="high-agency team"]').click();
    await page.locator('.js-value-chip[data-value="meaningful work"]').click();
    // Custom entry via the "Add your own" input.
    await page.locator('#wiz-values-custom-input').fill('remote-friendly');
    await page.locator('#btn-wiz-values-add').click();
    // Now 3 selected — attempting a 4th preset must not activate it and the
    // max-reached hint must appear.
    await page.locator('.js-value-chip[data-value="fast-paced team"]').click();
    await expect(page.locator('.js-value-chip[data-value="fast-paced team"]'))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#wiz-values-max')).toBeVisible();
    await page.locator('#btn-wizard-next').click();

    // Step 5 — environment (single-select cards)
    await expect(page.getByRole('heading', { name: 'Work environment' })).toBeVisible();
    await page.locator('.js-env-choice[data-env="remote"]').click();
    await expect(page.locator('.js-env-choice[data-env="remote"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await page.locator('#btn-wizard-next').click();

    // Step 6 — skills (required, compound row)
    await expect(page.getByRole('heading', { name: 'Your top skills' })).toBeVisible();
    await expect(page.locator('#btn-wizard-next')).toBeDisabled();
    const wizSkills = page.locator('#wiz-skills-editor');
    await wizSkills.locator('.js-skill-name').fill('Go');
    await wizSkills.locator('.js-skill-years').fill('6');
    await wizSkills.locator('.js-skill-level').selectOption('advanced');
    await wizSkills.locator('.js-add-skill').click();
    await expect(wizSkills.locator('.js-skill-pills span[data-skill-index]', { hasText: 'Go' })).toBeVisible();
    await expect(page.locator('#btn-wizard-next')).toBeEnabled();
    await page.locator('#btn-wizard-next').click();

    // Step 7 — preferred tools (optional). Add two chips, then Finish.
    await expect(page.getByRole('heading', { name: 'Tools you want to work with' })).toBeVisible();
    await page.locator('#wiz-tools-input').fill('Rust');
    await page.locator('#btn-wiz-tools-add').click();
    await expect(page.locator('#wiz-tools-list span[data-tool="Rust"]')).toBeVisible();
    // Enter key path also works.
    await page.locator('#wiz-tools-input').fill('Kafka');
    await page.locator('#wiz-tools-input').press('Enter');
    await expect(page.locator('#wiz-tools-list span[data-tool="Kafka"]')).toBeVisible();
    await page.locator('#btn-wizard-done').click();

    // Profile ready screen — check-circle + heading + Go-to-Overview.
    await expect(page.getByRole('heading', { name: 'Profile ready' })).toBeVisible();
    await page.getByRole('button', { name: /Go to Overview/i }).click();

    // Lands on the flat form; values round-trip.
    await expect(page.getByText('About you', { exact: true })).toBeVisible();
    await expect(page.locator('#ov-name')).toHaveValue('Nova Hoang');
    await expect(page.locator('#ov-headline')).toHaveValue('Backend engineer, data pipelines');
    await expect(page.locator('#ov-summary')).toHaveValue('Six years shipping backend systems.');
    // Environment card for "remote" is active on the flat form.
    await expect(page.locator('.js-env-choice[data-env="remote"]'))
      .toHaveAttribute('aria-pressed', 'true');
    // Tools survive.
    await expect(page.locator('#ov-tools-list span[data-tool="Rust"]')).toBeVisible();
    await expect(page.locator('#ov-tools-list span[data-tool="Kafka"]')).toBeVisible();
    // Skill pill (advanced → brand palette).
    const flatSkills = page.locator('#ov-skills-editor .js-skill-pills');
    await expect(flatSkills.locator('span[data-skill-index]', { hasText: 'Go' })).toBeVisible();
    await expect(flatSkills.locator('.bg-brand-tint')).toHaveCount(1);
    // Three P1 sparks were captured from step 4.
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(3);
  });

  test('Skip on a required step jumps back to the first incomplete required, not forward', async ({ page }) => {
    await gotoProfile(page);

    // Type name (step 1 satisfied), advance to step 2 (optional).
    await page.locator('#wiz-input').fill('Nova');
    await page.locator('#btn-wizard-next').click();
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();

    // Skip step 2 (optional). Skip on an optional step advances by one.
    await page.getByRole('button', { name: 'Skip this' }).click();
    await expect(page.getByRole('heading', { name: /kind of work do you want/i })).toBeVisible();

    // Step 3 is required and empty. Skip should NOT advance — it should jump
    // to the first incomplete required, which is step 3 itself (no-op).
    await page.getByRole('button', { name: 'Skip this' }).click();
    await expect(page.getByRole('heading', { name: /kind of work do you want/i })).toBeVisible();
  });

  test('resumes at the same step after a reload', async ({ page }) => {
    await gotoProfile(page);

    // Fill step 1 + advance to step 2, then reload — should land on step 2
    // with the previously-entered name persisted.
    await page.locator('#wiz-input').fill('Nova Hoang');
    await page.locator('#btn-wizard-next').click();
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
  });
});
