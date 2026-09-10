// BYOK variant of tailor-resume.spec.ts — analyze-role-signals →
// import-resume → tool loop, all through browser-side handlers.

import { expect, test, type Page } from './fixtures';
import { enableBYOK, interceptBYOKLLM, type BYOKCall } from './byok-fixtures';

const gotoApps = async (page: Page) => {
  await page.goto('/applications');
  await expect(page.getByText('Application tracker', { exact: true })).toBeVisible({ timeout: 30_000 });
};

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
      company_id: companyId, role_title: 'Backend Engineer', status: 'lead',
    });
    await updateApplicationExtraction(applicationId, {
      structuredJson: JSON.stringify({
        role_title: 'Backend Engineer', skills: ['Go', 'PostgreSQL'],
        responsibilities: ['own payments API'], function: 'engineering',
      }),
      jobDescriptionRaw: 'Hiring a backend engineer to own payments.',
    });
    await createResume({
      title: 'Base résumé', format: 'typ', isPrimary: true,
      body: '#set page(paper: "us-letter")\n= Alex\nBase content.',
    });
    await createBragEntry({
      title: 'Shipped payments API', body: 'Owned end-to-end.',
      impact: 'Cut latency 40%', category: 'experience',
    });
    return { companyId, applicationId };
  });
};

const CANNED_BASE_RESUME = {
  contact: { name: 'Alex' },
  experience: [{
    company: 'Prior', title: 'Engineer',
    bullets: [{ description: 'Base bullet.' }],
  }],
};

const CANNED_FINAL_DRAFT = {
  changes: [{
    section: 'experience', entry_index: 0, bullet_index: 0,
    before: 'Base bullet.', after: 'Owned end-to-end payments API delivery.',
    brag_id: 1, citations: ['Go'],
  }],
  resume: {
    contact: { name: 'Alex' },
    experience: [{
      company: 'Prior', title: 'Engineer',
      bullets: [{ description: 'Owned end-to-end payments API delivery.' }],
    }],
  },
};

const ROLE_SIGNALS_MARKDOWN = '### Desirable skills\n- Go\n- Distributed systems\n\n### ATS keywords\nGo, PostgreSQL';

// Route by call shape: `tools` set → tool-loop turn; otherwise
// analyze-role-signals first, then import-resume (fixed panel order).
const respondByFlow = (call: BYOKCall, _index: number, state: { analyzeAnswered: boolean }) => {
  if (call.tools?.length) return { content: JSON.stringify(CANNED_FINAL_DRAFT) };
  if (!state.analyzeAnswered) {
    state.analyzeAnswered = true;
    return { content: JSON.stringify({ signals: ROLE_SIGNALS_MARKDOWN, ats_keywords: ['Go', 'PostgreSQL'] }) };
  }
  return { content: JSON.stringify(CANNED_BASE_RESUME) };
};

test.describe('tailor résumé — BYOK', () => {
  test('BYOK tailor runs analyze → import-resume → tool loop and hands off draft', async ({ page }) => {
    await seedFixture(page);
    await enableBYOK(page);
    const state = { analyzeAnswered: false };
    const { calls } = await interceptBYOKLLM(page, (call, i) => respondByFlow(call, i, state));

    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: /Open Backend Engineer/ }).click();
    const panel = page.locator('#details-panel');
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'Tailor résumé' }).click();
    const tailorPanel = page.locator('#tailor-resume-panel');
    await expect(tailorPanel).toBeVisible();
    await tailorPanel.getByRole('button', { name: 'Generate' }).click();

    await expect(tailorPanel.getByText('Owned end-to-end payments API delivery.')).toBeVisible({ timeout: 20_000 });

    // Three LLM hops (analyze + import-resume + tool loop), at least one with tools.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.some((c) => c.tools?.length)).toBe(true);

    await tailorPanel.getByRole('button', { name: /Open draft/ }).click();
    const resumePanel = page.locator('#resume-panel');
    await expect(resumePanel).toBeVisible();
    const body = await resumePanel.locator('#res-body').inputValue();
    expect(body).toContain('Owned end-to-end payments API delivery');
  });
});
