// BYOK variant of profile-import.spec.ts. Enables BYOK and intercepts the
// outbound /chat/completions POST so the browser exercises the JS
// build()/parse() handlers under prompt-handlers/profile/*. Covers the
// interface where field-name drift between rpc.mjs and each handler hides
// (the `source` vs `markdown`/`typst` bug lived here).

import { expect, test, type Page } from './fixtures';
import { enableBYOK, interceptBYOKLLM, scriptedBYOKResponder } from './byok-fixtures';

const gotoProfile = async (page: Page) => {
  await page.goto('/profile');
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
};

const skipWizardIfPresent = async (page: Page) => {
  for (const label of ['Skip setup', 'Skip this']) {
    const btn = page.getByRole('button', { name: label });
    if (await btn.isVisible().catch(() => false)) await btn.click();
  }
  await page.getByText('Loading…').waitFor({ state: 'detached' }).catch(() => {});
  await expect(page.getByText('About you', { exact: true })).toBeVisible({ timeout: 10_000 });
};

// Canned import-resume response the JS parser will decode.
const CANNED_STRUCTURED_RESUME = {
  contact: { name: 'Ada Lovelace', email: 'ada@example.com', location: 'London' },
  education: [{ school: 'Analytical Engine Institute', degree: 'MS Computing', dates: '1843' }],
  experience: [{
    company: 'Difference Engine Co', title: 'Programmer',
    bullets: [{ lead_in: 'Notes', description: 'Wrote the first algorithm.' }],
  }],
};

test.describe('profile import — BYOK', () => {
  test('Build Typst résumé drives the JS import-resume handler through BYOK', async ({ page }) => {
    await gotoProfile(page);
    await skipWizardIfPresent(page);
    await enableBYOK(page);
    const { calls } = await interceptBYOKLLM(page, scriptedBYOKResponder([
      { content: JSON.stringify(CANNED_STRUCTURED_RESUME) },
    ]));

    await page.getByRole('button', { name: 'Import from file' }).click();
    // Bypass wasm extraction by populating the markdown textarea directly.
    await page.locator('#ri-result').evaluate((el) => el.classList.remove('hidden'));
    await page.locator('#ri-markdown').fill('# Ada Lovelace\n\nEngineer.\n');
    await page.getByRole('button', { name: 'Build Typst résumé' }).click();

    // The review panel appears; the Typst source contains canned content —
    // proving both build() (prompt assembly) and parse() (finalizer) ran
    // client-side against the LLM response.
    const source = page.locator('#ri-typst-source');
    await expect(source).toBeVisible({ timeout: 15_000 });
    const value = await source.inputValue();
    expect(value).toContain('Ada Lovelace');
    expect(value).toContain('Analytical Engine Institute');
    expect(value).toContain('Difference Engine Co');

    // Exactly one LLM call — the import-resume flow. Prompt body carries the
    // markdown we filled in, proving build() interpolated the source field
    // (regression guard for the source/markdown/typst bug).
    expect(calls).toHaveLength(1);
    const userMessage = calls[0].messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('Ada Lovelace');
  });
});
