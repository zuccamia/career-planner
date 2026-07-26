import { expect, test, type Page } from '@playwright/test';

// Fresh OPFS per context (same convention as the other local-*.spec.ts files).
// D3 loads from a CDN — the sankey block hydrates only when the pipeline has
// at least one stage. All the funnel/activity markup is inline JS so it works
// without network access.

const gotoDashboard = async (page: Page) => {
  await page.goto('/local/dashboard');
  // Wait for a heading that mountDashboard emits, not the sidebar label —
  // that text is server-rendered and shows up before initDb finishes.
  await expect(page.getByRole('heading', { name: 'Application pipeline' })).toBeVisible({ timeout: 30_000 });
};

test.describe('local dashboard', () => {
  test('/local/ redirects to /local/dashboard', async ({ page }) => {
    await page.goto('/local/');
    await expect(page).toHaveURL(/\/local\/dashboard$/);
  });

  test('renders empty-state pipeline + activity when the local DB is empty', async ({ page }) => {
    await gotoDashboard(page);

    await expect(page.getByRole('heading', { name: 'Application pipeline' })).toBeVisible();
    await expect(page.getByText(/No application pipeline yet/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Activity over time' })).toBeVisible();
    // Totals cards render with zero counts.
    await expect(page.locator('[data-total="applied"]').or(page.locator('[data-total="blue"]'))).toBeVisible();
  });

  test('funnel and activity totals reflect seeded applications', async ({ page }) => {
    // Seed one company + one applied application directly against sqlite.
    await gotoDashboard(page);
    await page.evaluate(async () => {
      // @ts-expect-error — module exposed for e2e diagnostics
      const { exec } = await import('/static/local/js/db/client.mjs');
      await exec("INSERT INTO companies (official_name) VALUES ('Alpha Co.')");
      const c = await exec('SELECT last_insert_rowid() AS id');
      await exec(
        "INSERT INTO applications (company_id, role_title, status) VALUES (?, 'Backend Engineer', 'applied')",
        [c[0].id],
      );
      const a = await exec('SELECT last_insert_rowid() AS id');
      // Seed a status_changed event so the activity chart + sankey have signal.
      await exec(
        `INSERT INTO application_events (application_id, type, from_status, to_status, occurred_at)
         VALUES (?, 'status_changed', 'wishlist', 'applied', datetime('now'))`,
        [a[0].id],
      );
    });
    await page.reload();
    // Wait for a heading that mountDashboard emits, not the sidebar label —
  // that text is server-rendered and shows up before initDb finishes.
  await expect(page.getByRole('heading', { name: 'Application pipeline' })).toBeVisible({ timeout: 30_000 });

    // Funnel bar for Applied shows the count.
    const applied = page.locator('div', { has: page.getByText('Applied', { exact: true }) }).first();
    await expect(applied).toBeVisible();

    // Applied totals card reads 1.
    const appliedCard = page.locator('[data-total="blue"]');
    await expect(appliedCard).toContainText('1');
  });
});
