import { expect, test, type Page } from '@playwright/test';

// Fresh OPFS per context — the 9-step wizard shows on first visit because
// profile_overview.onboarded_at is NULL and every field is empty.

const gotoProfile = async (page: Page) => {
  await page.goto('/profile');
  // The tab strip is only rendered by mountProfile after the DB is up, so it
  // doubles as a "page is live" wait.
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
};

test.describe('local profile page — wizard', () => {
  test('happy path walks all 9 steps, lands on Profile ready, then flat form has the values', async ({ page }) => {
    await gotoProfile(page);

    // Step 1 — name
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
    // Back is rendered but disabled on step 1 (spec: keep the slot to prevent layout shift).
    await expect(page.locator('#btn-wizard-back')).toBeDisabled();
    await page.locator('#wiz-input').fill('Nova Hoang');
    await page.locator('#btn-wizard-next').click();

    // Step 2 — pitch
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await page.locator('#wiz-input').fill('Backend engineer, data pipelines');
    await page.locator('#btn-wizard-next').click();

    // Step 3 — direction (textarea)
    await expect(page.getByRole('heading', { name: /kind of work do you want/i })).toBeVisible();
    await page.locator('#wiz-input').fill('Six years shipping backend systems.');
    await page.locator('#btn-wizard-next').click();

    // Step 4 — looking_for
    await expect(page.getByRole('heading', { name: /Role type you.re looking for/i })).toBeVisible();
    await page.locator('#wiz-looking-for').selectOption('full_time');
    await page.locator('#btn-wizard-next').click();

    // Step 5 — locations
    await expect(page.getByRole('heading', { name: 'Target locations' })).toBeVisible();
    await page.locator('#wiz-locations-input').fill('Remote');
    await page.locator('#btn-wiz-location-add').click();
    await expect(page.locator('#wiz-locations-list span[data-location="Remote"]')).toBeVisible();
    await page.locator('#wiz-locations-input').fill('New York, NY');
    await page.locator('#wiz-locations-input').press('Enter');
    await expect(page.locator('#wiz-locations-list span[data-location="New York, NY"]')).toBeVisible();
    await page.locator('#btn-wizard-next').click();

    // Step 6 — values (multi-select, max 3 → P1 sparks)
    await expect(page.getByRole('heading', { name: 'What matters most?' })).toBeVisible();
    await page.locator('.js-value-chip[data-value="high-agency team"]').click();
    await page.locator('.js-value-chip[data-value="meaningful work"]').click();
    await page.locator('#wiz-values-custom-input').fill('remote-friendly');
    await page.locator('#btn-wiz-values-add').click();
    await page.locator('.js-value-chip[data-value="fast-paced team"]').click();
    await expect(page.locator('.js-value-chip[data-value="fast-paced team"]'))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#wiz-values-max')).toBeVisible();
    await page.locator('#btn-wizard-next').click();

    // Step 7 — workplace type (single-select cards)
    await expect(page.getByRole('heading', { name: 'Workplace type' })).toBeVisible();
    await page.locator('.js-workplace-type-choice[data-workplace-type="remote"]').click();
    await expect(page.locator('.js-workplace-type-choice[data-workplace-type="remote"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await page.locator('#btn-wizard-next').click();

    // Step 8 — skills (compound row)
    await expect(page.getByRole('heading', { name: 'Your top skills' })).toBeVisible();
    const wizSkills = page.locator('#wiz-skills-editor');
    await wizSkills.locator('.js-skill-name').fill('Go');
    await wizSkills.locator('.js-skill-years').fill('6');
    await wizSkills.locator('.js-skill-level').selectOption('advanced');
    await wizSkills.locator('.js-add-skill').click();
    await expect(wizSkills.locator('.js-skill-pills span[data-skill-index]', { hasText: 'Go' })).toBeVisible();
    await page.locator('#btn-wizard-next').click();

    // Step 9 — tools (optional)
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
    await expect(page.locator('#ov-looking-for')).toHaveValue('full_time');
    await expect(page.locator('#ov-locations-list span[data-location="Remote"]')).toBeVisible();
    await expect(page.locator('#ov-locations-list span[data-location="New York, NY"]')).toBeVisible();
    // Workplace-type card for "remote" is active on the flat form.
    await expect(page.locator('.js-workplace-type-choice[data-workplace-type="remote"]'))
      .toHaveAttribute('aria-pressed', 'true');
    // Tools survive.
    await expect(page.locator('#ov-tools-list span[data-tool="Rust"]')).toBeVisible();
    await expect(page.locator('#ov-tools-list span[data-tool="Kafka"]')).toBeVisible();
    // Skill pill (advanced → brand palette).
    const flatSkills = page.locator('#ov-skills-editor .js-skill-pills');
    await expect(flatSkills.locator('span[data-skill-index]', { hasText: 'Go' })).toBeVisible();
    await expect(flatSkills.locator('.bg-brand-tint')).toHaveCount(1);
    // Three P1 sparks were captured from step 6.
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(3);
  });

  test('Skip on step 1/2/3 bails out of the wizard to the flat form', async ({ page }) => {
    await gotoProfile(page);

    // Step 1 skip → user doesn't want the guided flow → drop them into the
    // flat overview form and mark onboarded (so the wizard doesn't reappear
    // on reload).
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByText('About you', { exact: true })).toBeVisible();
  });

  test('Back navigation preserves entered data on prior steps', async ({ page }) => {
    await gotoProfile(page);

    // Step 1 — enter name, advance.
    await page.locator('#wiz-input').fill('Nova Hoang');
    await page.locator('#btn-wizard-next').click();

    // Step 2 — enter pitch, advance to step 3.
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await page.locator('#wiz-input').fill('Backend engineer');
    await page.locator('#btn-wizard-next').click();

    // Step 3 — click Back, should land on step 2 with pitch preserved.
    await expect(page.getByRole('heading', { name: /kind of work do you want/i })).toBeVisible();
    await page.locator('#btn-wizard-back').click();
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await expect(page.locator('#wiz-input')).toHaveValue('Backend engineer');

    // Back again → step 1 with name preserved.
    await page.locator('#btn-wizard-back').click();
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
    await expect(page.locator('#wiz-input')).toHaveValue('Nova Hoang');
    // Back on step 1 is disabled — no further nav possible.
    await expect(page.locator('#btn-wizard-back')).toBeDisabled();
  });

  test('Redo intro pre-selects existing sparks and grandfathers them past the max-3 cap', async ({ page }) => {
    await gotoProfile(page);

    // Walk to step 6. Skip on steps 1-3 exits the wizard, so those must
    // use Next (with or without filled input); Skip is fine from step 4+.
    await page.locator('#wiz-input').fill('Nova');
    await page.locator('#btn-wizard-next').click();
    await page.locator('#btn-wizard-next').click(); // step 2 (pitch): Next through empty
    await page.locator('#wiz-input').fill('Six years shipping backend systems.');
    await page.locator('#btn-wizard-next').click();
    await page.getByRole('button', { name: 'Skip this' }).click(); // skip looking_for
    await page.getByRole('button', { name: 'Skip this' }).click(); // skip locations

    // Step 6 — pick two presets + add one custom (3 sparks total).
    await expect(page.getByRole('heading', { name: 'What matters most?' })).toBeVisible();
    await page.locator('.js-value-chip[data-value="high-agency team"]').click();
    await page.locator('.js-value-chip[data-value="meaningful work"]').click();
    await page.locator('#wiz-values-custom-input').fill('remote-friendly');
    await page.locator('#btn-wiz-values-add').click();
    await page.locator('#btn-wizard-next').click();

    // Skip the rest to reach Done. Skills is required — fill minimum.
    await page.getByRole('button', { name: 'Skip this' }).click(); // env
    await expect(page.getByRole('heading', { name: 'Your top skills' })).toBeVisible();
    const skills = page.locator('#wiz-skills-editor');
    await skills.locator('.js-skill-name').fill('Go');
    await skills.locator('.js-add-skill').click();
    await page.locator('#btn-wizard-next').click();
    await page.locator('#btn-wizard-done').click();

    // Ready → flat form. Confirm the three sparks exist.
    await page.getByRole('button', { name: /Go to Overview/i }).click();
    await expect(page.locator('#sparks-list span[data-spark-id]')).toHaveCount(3);

    // Redo intro → back at step 1.
    await page.getByRole('button', { name: 'Redo intro' }).click();
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();

    // Walk forward to step 6. Steps 1-3 must use Next (Skip on those exits
    // the wizard); Skip is fine from step 4+.
    await page.locator('#btn-wizard-next').click(); // step 1 already filled
    await page.locator('#btn-wizard-next').click(); // step 2 (pitch): Next through empty
    await page.locator('#btn-wizard-next').click(); // step 3 already filled
    await page.getByRole('button', { name: 'Skip this' }).click(); // step 4
    await page.getByRole('button', { name: 'Skip this' }).click(); // step 5
    await expect(page.getByRole('heading', { name: 'What matters most?' })).toBeVisible();

    // Existing sparks should show up highlighted. Two matched presets +
    // one custom chip appended.
    await expect(page.locator('.js-value-chip[data-value="high-agency team"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.js-value-chip[data-value="meaningful work"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.js-value-chip[data-value="remote-friendly"]'))
      .toHaveAttribute('aria-pressed', 'true');
    // Custom-chip carrying an existing spark is flagged data-existing="1" so
    // it doesn't consume a cap slot.
    await expect(page.locator('.js-value-chip[data-value="remote-friendly"]'))
      .toHaveAttribute('data-existing', '1');

    // Cap grandfather: max note is hidden even though 3 chips are pressed.
    await expect(page.locator('#wiz-values-max')).toBeHidden();

    // The user can still pick 3 more new preset chips without deselecting.
    await page.locator('.js-value-chip[data-value="fast-paced team"]').click();
    await page.locator('.js-value-chip[data-value="own your schedule"]').click();
    await page.locator('.js-value-chip[data-value="learning & growth"]').click();
    await expect(page.locator('.js-value-chip[data-value="fast-paced team"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.js-value-chip[data-value="learning & growth"]'))
      .toHaveAttribute('aria-pressed', 'true');
    // Only now (4th new pick attempted) should the cap kick in.
    await page.locator('.js-value-chip[data-value="high compensation"]').click();
    await expect(page.locator('.js-value-chip[data-value="high compensation"]'))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#wiz-values-max')).toBeVisible();
  });

  // Regression: mid-wizard Import → Extract overview → Apply must leave the
  // wizard resumed with the extracted values. Clicking any nav (Next/Back)
  // on the wizard snapshots the whole state into wizard_progress with '' for
  // untouched scalars. That non-null empty in progress used to clobber the
  // freshly-persisted overview values in seedWizardStateFrom, so the wizard
  // reappeared blank after Apply.
  test('mid-wizard import overview → Apply pre-fills the resumed wizard', async ({ page }) => {
    await page.route('**/api/llm/server-status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ available: true, provider: 'stub', model: 'stub' }) }),
    );
    await page.route('**/api/profile/extract-overview-from-resume', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        name: 'Ada Lovelace',
        headline: 'Analytical Engineer',
        summary: 'Wrote the first algorithm.',
        workplace_type: 'remote',
        skills: [{ name: 'Analytics' }],
        tools: ['Difference Engine'],
      }) }),
    );

    await gotoProfile(page);

    // Land on the wizard, then click Next without typing to persist an
    // empty snapshot into wizard_progress. Back returns to step 1 so the
    // post-Apply resume lands where we can assert the name field.
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
    await page.locator('#btn-wizard-next').click();
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await page.locator('#btn-wizard-back').click();
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();

    // Import → extract → Apply. Leaves default (all-checked) selection so
    // every extracted field lands in the DB via updateOverview.
    await page.getByRole('button', { name: 'Import from file' }).click();
    await page.locator('#ri-result').evaluate((el) => el.classList.remove('hidden'));
    await page.locator('#ri-markdown').fill('# Ada Lovelace\n\nAnalytical engineer.\n');
    await page.getByRole('button', { name: 'Extract profile overview' }).click();
    await expect(page.getByRole('button', { name: 'Apply selected' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Apply selected' }).click();

    // Redirected back to the wizard (progress != null → isFirstRun true).
    // Step 1's name input must show the extracted name, not the empty
    // snapshot that persistProgress wrote earlier.
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
    await expect(page.locator('#wiz-input')).toHaveValue('Ada Lovelace');
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
