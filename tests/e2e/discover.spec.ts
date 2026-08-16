import { expect, test, type Page } from '@playwright/test';

// Route-stubbed coverage for the Discover openings feature. The real
// pipeline needs an LLM + SearXNG, both impractical in CI, so we intercept
// the two Discover HTTP surfaces and return canned payloads. That covers
// the UI wiring end-to-end (CTA reveal → panel open → results render →
// Save-as-application) without any external dependency.

const CANNED_RECS = {
  recommendations: [
    {
      title: 'Backend Engineer',
      company: 'Acme',
      url: 'https://boards.greenhouse.io/acme/jobs/1234',
      match_score: 92,
      rationale: 'Strong Go + Postgres fit',
      provider: 'greenhouse',
      board_url: 'https://boards.greenhouse.io/acme',
      posted_at: '2026-08-08T10:00:00Z',
    },
    {
      title: 'Platform Engineer',
      company: 'Globex',
      url: 'https://jobs.lever.co/globex/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      match_score: 78,
      rationale: 'Adjacent stack',
      provider: 'lever',
      board_url: 'https://jobs.lever.co/globex',
      posted_at: '2026-08-07T09:00:00Z',
    },
  ],
  diagnostics: [],
};

// stubDiscoverEndpoints wires page.route intercepts for the two /api/discover
// paths so tests never touch a real LLM/SearXNG. Call BEFORE navigating so
// the initial header-cta.mjs status probe hits the stub too.
const stubDiscoverEndpoints = async (
  page: Page,
  { available = true, recs = CANNED_RECS }: { available?: boolean; recs?: typeof CANNED_RECS } = {},
) => {
  await page.route('**/api/discover/server-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available,
        llm_available: available,
        search_available: available,
        provider: available ? 'searxng' : '',
      }),
    });
  });
  await page.route('**/api/discover/run', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(recs),
    });
  });
};

// gotoDashboardWithHeadline stubs Discover, walks the profile wizard just
// far enough to seed name + headline, then navigates to /dashboard. The
// header CTA only reveals the Discover button when profile.headline is
// set, so the wizard-fill is the reliable way to get there.
const gotoDashboardWithHeadline = async (page: Page) => {
  await stubDiscoverEndpoints(page);
  await page.goto('/profile');
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
  // Wizard step 1 → name.
  await page.locator('#wiz-input').fill('Nova');
  await page.locator('#btn-wizard-next').click();
  // Wizard step 2 → pitch (this maps to profile_overview.headline).
  await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
  await page.locator('#wiz-input').fill('Backend Engineer');
  // Skip on step 2 exits the wizard entirely (see WIZARD_EXIT_ON_SKIP)
  // and drops us on the flat form with the pitch persisted as headline.
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await expect(page.getByText('About you', { exact: true })).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Application pipeline' })).toBeVisible({ timeout: 30_000 });
};

test.describe('discover', () => {
  test('header CTA reveals Discover button when server-status is available', async ({ page }) => {
    await gotoDashboardWithHeadline(page);
    await expect(page.locator('#header-btn-discover')).toBeVisible();
  });

  test('opening the panel and running Find openings renders the canned recommendations', async ({ page }) => {
    await gotoDashboardWithHeadline(page);
    await page.locator('#header-btn-discover').click();

    // Panel opened with the two action buttons.
    await expect(page.getByRole('button', { name: 'Find openings' })).toBeVisible();

    await page.getByRole('button', { name: 'Find openings' }).click();

    // Both canned recs render as cards with title + company visible.
    await expect(page.getByRole('heading', { name: 'Backend Engineer' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Platform Engineer' })).toBeVisible();
    // The "Open posting" link on each card points at the rec URL.
    await expect(page.getByRole('link', { name: 'Open posting' }).first()).toHaveAttribute(
      'href',
      'https://boards.greenhouse.io/acme/jobs/1234',
    );
  });

  test('Save as application creates the company + application row', async ({ page }) => {
    await gotoDashboardWithHeadline(page);
    await page.locator('#header-btn-discover').click();
    await page.getByRole('button', { name: 'Find openings' }).click();
    await expect(page.getByRole('heading', { name: 'Backend Engineer' })).toBeVisible();

    const firstCard = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Backend Engineer' }) });
    await firstCard.getByRole('button', { name: 'Save as application' }).click();

    // Save success swaps the label to "Saved"; app also toasts.
    await expect(firstCard.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 10_000 });

    // Verify persistence by reading the DB directly.
    const persisted = await page.evaluate(async () => {
      const mod = await import('/static/js/db/client.mjs');
      const companies = await mod.exec("SELECT official_name, ats_url, ats_provider FROM companies");
      const apps = await mod.exec("SELECT role_title, job_posting_url, status FROM applications");
      return { companies, apps };
    });
    expect(persisted.companies).toContainEqual({
      official_name: 'Acme',
      ats_url: 'https://boards.greenhouse.io/acme',
      ats_provider: 'greenhouse',
    });
    expect(persisted.apps).toContainEqual({
      role_title: 'Backend Engineer',
      job_posting_url: 'https://boards.greenhouse.io/acme/jobs/1234',
      status: 'lead',
    });
  });

  test('dismissing a rec sends its URL in exclude_urls on the next Run', async ({ page }) => {
    // Capture the request bodies both Runs POST to /api/discover/run so
    // we can assert that only URLs the user explicitly dismisses land in
    // Run 2's exclude_urls (not every URL shown).
    const bodies: any[] = [];
    await page.route('**/api/discover/server-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: true, llm_available: true, search_available: true, provider: 'searxng' }),
      });
    });
    await page.route('**/api/discover/run', async (route) => {
      const payload = JSON.parse(route.request().postData() || '{}');
      bodies.push(payload);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CANNED_RECS) });
    });

    await page.goto('/profile');
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
    await page.locator('#wiz-input').fill('Nova');
    await page.locator('#btn-wizard-next').click();
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await page.locator('#wiz-input').fill('Backend Engineer');
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByText('About you', { exact: true })).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Application pipeline' })).toBeVisible({ timeout: 30_000 });

    await page.locator('#header-btn-discover').click();
    await page.getByRole('button', { name: 'Find openings' }).click();
    await expect(page.getByRole('heading', { name: 'Backend Engineer' })).toBeVisible();

    // Dismiss the first rec — this is the ONLY way a URL enters
    // exclude_urls now that we removed auto-track-every-shown.
    await page.locator('button[data-discover-dismiss="0"]').click();

    // Second Run.
    await expect(page.locator('#btn-discover-run span')).toHaveText('Run again');
    await page.locator('#btn-discover-run').click();
    await expect.poll(() => bodies.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // Run 1: no exclude_urls (IDB empty).
    expect(bodies[0].exclude_urls || []).toHaveLength(0);
    // Run 2: exclude_urls has ONLY the dismissed URL, not both recs.
    const excluded: string[] = bodies[1].exclude_urls || [];
    expect(excluded).toContain('https://boards.greenhouse.io/acme/jobs/1234');
    expect(excluded).not.toContain('https://jobs.lever.co/globex/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  test('empty recommendations show the diagnostic message', async ({ page }) => {
    await stubDiscoverEndpoints(page, {
      recs: { recommendations: [], diagnostics: ['No matching postings surfaced across the searched ATS hosts.'] },
    });
    await page.goto('/profile');
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
    await page.locator('#wiz-input').fill('Nova');
    await page.locator('#btn-wizard-next').click();
    await expect(page.getByRole('heading', { name: 'Your one-line pitch' })).toBeVisible();
    await page.locator('#wiz-input').fill('Backend Engineer');
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByText('About you', { exact: true })).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Application pipeline' })).toBeVisible({ timeout: 30_000 });
    await page.locator('#header-btn-discover').click();
    await page.getByRole('button', { name: 'Find openings' }).click();
    await expect(page.getByText('No matching postings surfaced across the searched ATS hosts.')).toBeVisible();
  });
});
