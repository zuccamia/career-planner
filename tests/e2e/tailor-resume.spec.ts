import { expect, test, type Page } from './fixtures';

// Tailor résumé end-to-end. Mocks the four server LLM endpoints in the
// pipeline (server-status, analyze-role-signals, extract-structured-resume,
// tailor) so no real LLM is required. The composite /api/applications/tailor
// endpoint runs rank + tailor server-side — one browser round trip.

const gotoApps = async (page: Page) => {
  await page.goto('/applications');
  await expect(page.getByText('Application tracker', { exact: true })).toBeVisible({ timeout: 30_000 });
};

// Seeds one company, one application (with a pre-extracted JD JSON), one base
// résumé, and three brags (one per category). Returns the application id.
const seedFixture = async (page: Page) => {
  await gotoApps(page);
  return page.evaluate(async () => {
    const [{ createCompany }, { createApplication, updateApplicationExtraction }, { createResume, createBragEntry }] = await Promise.all([
      import('/static/js/entities/companies.mjs'),
      import('/static/js/entities/applications.mjs'),
      import('/static/js/entities/profile.mjs'),
    ]);
    const companyId = await createCompany({ official_name: 'Acme Corp' });
    const applicationId = await createApplication({
      company_id: companyId,
      role_title: 'Backend Engineer',
      status: 'lead',
    });
    await updateApplicationExtraction(applicationId, {
      structuredJson: JSON.stringify({
        role_title: 'Backend Engineer',
        skills: ['Go', 'PostgreSQL'],
        responsibilities: ['own payments API'],
      }),
      jobDescriptionRaw: 'Hiring a backend engineer to own payments.',
    });
    await createResume({
      title: 'Base résumé',
      format: 'typ',
      body: '#set page(paper: "us-letter")\n= Alex\nBase content.',
      isPrimary: true,
    });
    await createBragEntry({
      title: 'Shipped payments API',
      body: 'Owned end-to-end.',
      impact: 'Cut latency 40%',
      category: 'experience',
    });
    await createBragEntry({
      title: 'Rewrote personal blog',
      body: 'Static site generator side project.',
      category: 'project',
    });
    await createBragEntry({
      title: 'Mentored bootcamp students',
      body: 'Weekly office hours.',
      category: 'activity',
    });
    return { companyId, applicationId };
  });
};

const BRIEF_MARKDOWN = '### Desirable skills\n- Go\n- Distributed systems\n\n### Notes\n- Strong owner/operator instincts';

const setupTailorMocks = async (page: Page) => {
  const counters = { signals: 0, extract: 0, tailor: 0 };

  // Advertise server LLM as available so llmCall doesn't preflight-fail
  // (BYOK isn't configured in this test).
  await page.route('**/api/llm/server-status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ available: true, provider: 'stub', model: 'stub' }) }),
  );

  await page.route('**/api/applications/analyze-role-signals', (route) => {
    counters.signals++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ signals: BRIEF_MARKDOWN, ats_keywords: ['Go', 'PostgreSQL'] }) });
  });

  await page.route('**/api/profile/import-resume', (route) => {
    counters.extract++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        contact: { name: 'Alex' },
        experience: [{ company: 'Prior', title: 'Engineer', bullets: [{ description: 'Base bullet.' }] }],
        projects: [{ name: 'Prior project', description: 'Old.' }],
        activities: [{ name: 'Prior activity', description: 'Old.' }],
      }) });
  });

  // Composite endpoint. Server-side ranks + drafts internally; mock returns
  // the final TailorResumeResponse ({changes, resume}).
  await page.route('**/api/applications/tailor', (route) => {
    counters.tailor++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        changes: [{
          section: 'experience',
          entry_index: 0,
          bullet_index: 0,
          before: 'Base bullet.',
          after: 'Owned end-to-end payments API delivery.',
          brag_id: 1,
          citations: ['Go'],
        }],
        resume: {
          contact: { name: 'Alex' },
          experience: [{ company: 'Prior', title: 'Engineer',
            bullets: [{ description: 'Owned end-to-end payments API delivery.' }] }],
          projects: [{ name: 'Prior project', description: 'Refit for the role.' }],
          activities: [{ name: 'Prior activity', description: 'Refit for the role.' }],
        },
      }) });
  });

  return counters;
};

test.describe('tailor résumé — golden path', () => {
  test('first Generate derives signals, runs composite tailor, hands off to editor prefilled', async ({ page }) => {
    await seedFixture(page);
    const counters = await setupTailorMocks(page);

    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: /Open Backend Engineer/ }).click();
    const panel = page.locator('#details-panel');
    await expect(panel).toBeVisible();

    // Kick off the pipeline.
    await panel.getByRole('button', { name: 'Tailor résumé' }).click();
    const tailorPanel = page.locator('#tailor-resume-panel');
    await expect(tailorPanel).toBeVisible();
    await tailorPanel.getByRole('button', { name: 'Generate' }).click();

    // Tailored diff appears — the `after` text lands in the result section.
    await expect(tailorPanel.getByText('Owned end-to-end payments API delivery.')).toBeVisible({ timeout: 15_000 });

    // Endpoint counts — signals derives once, base extracts once, composite
    // tailor endpoint hit once. No separate rank counter (rank is now
    // server-internal to the composite endpoint).
    expect(counters.signals).toBe(1);
    expect(counters.extract).toBe(1);
    expect(counters.tailor).toBe(1);

    // "Open draft" hands off to the résumé editor with the deterministic title.
    await tailorPanel.getByRole('button', { name: /Open draft/ }).click();
    const resumePanel = page.locator('#resume-panel');
    await expect(resumePanel).toBeVisible();
    await expect(resumePanel.locator('#res-title')).toHaveValue('Acme Corp — Backend Engineer');
    const body = await resumePanel.locator('#res-body').inputValue();
    expect(body).toContain('Owned end-to-end payments API delivery');
  });

  test('Save inside the résumé editor reopens the panel in edit mode for the new row', async ({ page }) => {
    await seedFixture(page);
    await setupTailorMocks(page);

    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: /Open Backend Engineer/ }).click();
    const detailsPanel = page.locator('#details-panel');
    await detailsPanel.getByRole('button', { name: 'Tailor résumé' }).click();
    const tailorPanel = page.locator('#tailor-resume-panel');
    await tailorPanel.getByRole('button', { name: 'Generate' }).click();
    await expect(tailorPanel.getByText('Owned end-to-end payments API delivery.')).toBeVisible({ timeout: 15_000 });
    await tailorPanel.getByRole('button', { name: /Open draft/ }).click();

    // Create-mode markers: no delete button, no attach-history section.
    const resumePanel = page.locator('#resume-panel');
    await expect(resumePanel).toBeVisible();
    await expect(resumePanel.locator('#btn-resume-delete')).toHaveCount(0);
    await expect(resumePanel.locator('#resume-panel-attached-section')).toHaveCount(0);

    // Persist the draft. The create branch re-opens this same panel in edit
    // mode against the freshly-created résumé row.
    await resumePanel.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toContainText(/Created resume/, { timeout: 10_000 });

    // Edit-mode markers now present.
    await expect(resumePanel.locator('#btn-resume-delete')).toBeVisible({ timeout: 10_000 });
    await expect(resumePanel.locator('#resume-panel-attached-section')).toBeVisible();
    await expect(resumePanel.getByText('Edit resume', { exact: true })).toBeVisible();
  });

  test('Analyze slide-over caches the signals; tailor pipeline reuses it without re-derive', async ({ page }) => {
    await seedFixture(page);
    const counters = await setupTailorMocks(page);

    // First analyze → derive + cache.
    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: /Open Backend Engineer/ }).click();
    const detailsPanel = page.locator('#details-panel');
    await detailsPanel.getByRole('button', { name: 'Analyze role' }).click();
    const briefPanel = page.locator('#role-signals-panel');
    await expect(briefPanel).toBeVisible();
    await briefPanel.getByRole('button', { name: 'Analyze' }).click();
    await expect(briefPanel.getByRole('heading', { name: 'Desirable skills' })).toBeVisible({ timeout: 15_000 });
    expect(counters.signals).toBe(1);

    // Close the signals slide-over, run tailor — no new derive call.
    await briefPanel.locator('#btn-signals-close').click();
    await detailsPanel.getByRole('button', { name: 'Tailor résumé' }).click();
    const tailorPanel = page.locator('#tailor-resume-panel');
    await tailorPanel.getByRole('button', { name: 'Generate' }).click();
    await expect(tailorPanel.getByText('Owned end-to-end payments API delivery.')).toBeVisible({ timeout: 15_000 });
    expect(counters.signals).toBe(1);
    expect(counters.tailor).toBe(1);
  });
});
