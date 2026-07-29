import { expect, test, type Page } from '@playwright/test';

// Same fresh-OPFS-per-context model as the other local-*.spec.ts files. LLM
// buttons are not exercised (the test env has the provider disabled).

const gotoApps = async (page: Page, query = '') => {
  await page.goto(`/local/applications${query}`);
  await expect(page.getByText('Application tracker', { exact: true })).toBeVisible({ timeout: 30_000 });
};

const createCompany = async (page: Page, name: string) => {
  await page.goto('/local/companies');
  await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add company' }).click();
  await page.getByLabel('Official name').fill(name);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.locator('#list-content li', { hasText: name })).toBeVisible();
};

const createApplication = async (page: Page, companyName: string, role: string) => {
  await gotoApps(page, '?new=1');
  await expect(page.getByText('New application')).toBeVisible();
  await page.getByLabel('Company', { exact: true }).selectOption({ label: companyName });
  await page.getByLabel('Role').fill(role);
  await page.getByRole('button', { name: 'Create application' }).click();
  await expect(page.locator('#toast')).toContainText(/Created application/);
};

test.describe('local applications page — company filter', () => {
  test('?company_id=… filters the list and Clear link restores it', async ({ page }) => {
    // Seed two companies + one application each so the filter has a signal.
    await createCompany(page, 'Alpha Co.');
    await createCompany(page, 'Beta Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');
    await createApplication(page, 'Beta Co.', 'Frontend Engineer');

    // Enter via the companies page pill so the navigation matches real usage.
    await page.goto('/local/companies');
    await expect(page.getByText('Companies', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.locator('#list-content li', { hasText: 'Alpha Co.' })
      .getByTitle('Applications at Alpha Co.').click();

    await expect(page).toHaveURL(/\/local\/applications\?company_id=\d+$/);
    await expect(page.getByText('Filtered by company:')).toBeVisible();
    await expect(page.locator('#app-count')).toHaveText(/1 application at Alpha Co\./);
    await expect(page.locator('#list-content li')).toHaveCount(1);
    await expect(page.locator('#list-content li', { hasText: 'Backend Engineer' })).toBeVisible();
    await expect(page.locator('#list-content li', { hasText: 'Frontend Engineer' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Clear filter' }).click();
    await expect(page).toHaveURL(/\/local\/applications$/);
    await expect(page.getByText('Filtered by company:')).toHaveCount(0);
    await expect(page.locator('#list-content li')).toHaveCount(2);
  });

  test('?company_id=… with an unknown id falls back to the full list with a warning', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page, '?company_id=99999');
    await expect(page.locator('#toast')).toContainText(/Company #99999 not found/);
    await expect(page.getByText('Filtered by company:')).toHaveCount(0);
    await expect(page.locator('#list-content li', { hasText: 'Backend Engineer' })).toBeVisible();
  });
});

test.describe('local applications page — inline details panel', () => {
  test('clicking the role title opens the inline details panel', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' }).getByRole('button', { name: 'View' }).click();

    const panel = page.locator('#details-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Backend Engineer' })).toBeVisible();
    // "Application created" event is auto-emitted at create time.
    await expect(panel.getByText(/Application created/)).toBeVisible();
    // URL does NOT change — the panel is inline like the company dossier.
    await expect(page).toHaveURL(/\/local\/applications$/);
  });

  test('quick-status update writes a status_changed event to the timeline', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' }).getByRole('button', { name: 'View' }).click();
    const panel = page.locator('#details-panel');
    await expect(panel).toBeVisible();

    // Quick-status widget: change wishlist → applied, then verify timeline.
    await panel.getByLabel('Status', { exact: true }).selectOption('applied');
    await panel.getByRole('button', { name: 'Update status' }).click();
    await expect(page.locator('#toast')).toContainText(/Status → Applied/);
    await expect(panel.getByText(/Status changed: Wishlist → Applied/)).toBeVisible();
  });

  test('editing non-status fields does not append a timeline event', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: 'Edit application' }).click();
    await page.getByLabel('Role').fill('Senior Backend Engineer');
    await page.getByLabel('Notes', { exact: true }).fill('followed up on 2026-07-24');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.locator('#toast')).toContainText(/Application saved/);
    // Reopen the details panel — timeline should only hold the "Application
    // created" event; no "Updated …" note event for non-status edits.
    await page.locator('#list-content li', { hasText: 'Senior Backend Engineer' })
      .getByRole('button', { name: 'View' }).click();
    const panel = page.locator('#details-panel');
    await expect(panel.getByText(/Application created/)).toBeVisible();
    await expect(panel.getByText(/Updated /)).toHaveCount(0);
  });

  test('editing preserves the extracted job description JSON', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    // Seed an extracted JD directly against the local sqlite so we don't need
    // to hit the LLM. Any structured payload that renders a badge works.
    await page.goto('/local/applications');
    await expect(page.getByText('Application tracker', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(async () => {
      // @ts-expect-error — helpers exposed on window for e2e diagnostics
      const { exec } = await import('/static/local/js/db/client.mjs');
      const payload = JSON.stringify({
        schema_version: 'job_description.v1',
        role_level: 'senior',
        summary: 'seeded for regression test',
      });
      await exec(
        "UPDATE applications SET job_description_extracted_json = ? WHERE role_title = 'Backend Engineer'",
        [payload],
      );
    });
    await page.reload();
    await expect(page.getByText('Application tracker', { exact: true })).toBeVisible({ timeout: 30_000 });

    // Confirm the seeded structured JD renders before editing.
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: 'View' }).click();
    const panel = page.locator('#details-panel');
    await expect(panel.getByText('seeded for regression test')).toBeVisible();

    // Edit an unrelated field via the list-card editor.
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: 'Edit application' }).click();
    await page.getByLabel('Notes', { exact: true }).fill('touched');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#toast')).toContainText(/Application saved/);

    // Reopen details — the structured summary must still be there.
    await page.locator('#list-content li', { hasText: 'Backend Engineer' })
      .getByRole('button', { name: 'View' }).click();
    await expect(panel.getByText('seeded for regression test')).toBeVisible();
  });

  test('editor picks a contact scoped to the selected company', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');

    // Seed a person at Alpha Co. so the dropdown has an option to pick.
    await page.goto('/local/people');
    await expect(page.getByText('People', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Add person' }).click();
    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Company', { exact: true }).selectOption({ label: 'Alpha Co.' });
    await page.getByRole('button', { name: 'Create person' }).click();
    await expect(page.locator('#list-content li', { hasText: 'Jane Doe' })).toBeVisible();

    // Create an application and pick Jane as the point of contact.
    await gotoApps(page, '?new=1');
    await page.getByLabel('Company', { exact: true }).selectOption({ label: 'Alpha Co.' });
    await page.getByLabel('Role').fill('Backend Engineer');
    await page.getByLabel('Point of contact').selectOption({ label: 'Jane Doe' });
    await page.getByRole('button', { name: 'Create application' }).click();
    await expect(page.locator('#toast')).toContainText(/Created application/);

    // Card subline should read "Alpha Co. · Jane Doe".
    const card = page.locator('#list-content li', { hasText: 'Backend Engineer' });
    await expect(card.getByText(/Alpha Co\. · Jane Doe/)).toBeVisible();

    // Details panel surfaces the contact too.
    await card.getByRole('button', { name: 'View' }).click();
    // Contact appears twice: header subline + "Point of contact" info line.
    await expect(page.locator('#details-panel').getByText('Jane Doe').first()).toBeVisible();
  });

  test('close button collapses the details panel', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    await page.locator('#list-content li', { hasText: 'Backend Engineer' }).getByRole('button', { name: 'View' }).click();
    const panel = page.locator('#details-panel');
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
  });
});

// ---------- attachments (polymorphic table, folder+filename storage) ----------

// Install an in-memory fake in place of the localDisk backend so uploads work
// in headless Chromium (no File System Access picker, no OAuth popup). Kept in
// page.evaluate so the singleton the app code imports is the one we mutate.
// Returns a helper handle for later assertions.
const installFakeStorageBackend = async (page: Page) => {
  await page.evaluate(async () => {
    const mod = await import('/static/local/js/storage/index.mjs');
    // @ts-expect-error — expose blobs for cross-boundary reads
    window.__attachmentFiles = new Map<string, number>();
    const files: Map<string, Uint8Array> = new Map();
    const disk = mod.localDisk;
    disk.isReady = () => true;
    disk.isAvailable = () => true;
    disk.hasAttachment = async (folder: string, filename: string) =>
      files.has(`${folder}/${filename}`);
    disk.saveAttachment = async (folder: string, filename: string, bytes: Uint8Array) => {
      files.set(`${folder}/${filename}`, new Uint8Array(bytes));
      // @ts-expect-error — mirror sizes into a plain-object map for readback
      window.__attachmentFiles.set(`${folder}/${filename}`, bytes.byteLength);
      return { storedFilename: filename, sizeBytes: bytes.byteLength };
    };
    disk.loadAttachment = async (folder: string, filename: string) => {
      const b = files.get(`${folder}/${filename}`);
      if (!b) throw new Error(`not found: ${folder}/${filename}`);
      return b;
    };
  });
};

const readStoredKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    // @ts-expect-error — populated by installFakeStorageBackend
    return Array.from(window.__attachmentFiles.keys()) as string[];
  });

const openDetails = async (page: Page, roleTitle: string) => {
  await page.locator('#list-content li', { hasText: roleTitle })
    .getByRole('button', { name: 'View' }).click();
  const panel = page.locator('#details-panel');
  await expect(panel).toBeVisible();
  return panel;
};

test.describe('local applications page — attachments', () => {
  test('sanitizeFolder produces snake_case, case-insensitive, unassigned fallback', async ({ page }) => {
    // Any page that has already run ensureSchema() will do — go to /local/applications
    // so the module graph (including storage/attachments.mjs) is loaded.
    await gotoApps(page);
    const results = await page.evaluate(async () => {
      const { sanitizeFolder } = await import('/static/local/js/storage/attachments.mjs');
      return {
        withPunct:   sanitizeFolder('Meta Platforms, Inc.'),
        upper:       sanitizeFolder('META'),
        lower:       sanitizeFolder('meta'),
        amp:         sanitizeFolder('AT&T'),
        whitespace:  sanitizeFolder('  '),
        empty:       sanitizeFolder(''),
        nullish:     sanitizeFolder(null as unknown as string),
      };
    });
    expect(results).toEqual({
      withPunct:  'meta_platforms_inc',
      upper:      'meta',
      lower:      'meta',
      amp:        'at_t',
      whitespace: 'unassigned',
      empty:      'unassigned',
      nullish:    'unassigned',
    });
  });

  test('upload without a connected backend surfaces an inline error, no toast', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    const panel = await openDetails(page, 'Backend Engineer');
    await expect(panel.getByRole('heading', { name: 'Attachments' })).toBeVisible();

    // Neither LocalDisk (no picker) nor Drive (no OAuth) is connected in
    // headless tests → availableBackends() is empty → uploadAttachment throws.
    await panel.locator('#attachment-upload-input').setInputFiles({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('pretend pdf'),
    });

    const errorBanner = panel.locator('#attachment-upload-error');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText('No storage connected');
    // Toast surface must NOT carry the failure — the inline banner is the sole
    // failure UX. Success paths still toast.
    await expect(page.locator('#toast')).not.toContainText(/Upload failed/);
    // Button label restored so the user can retry.
    await expect(panel.locator('#attachment-upload-label')).toHaveText('Upload file');
    // No attachment row was written.
    await expect(panel.getByText('No attachments yet.')).toBeVisible();
  });

  test('upload succeeds, writes under the sanitized company folder, and shows the file in the list', async ({ page }) => {
    await createCompany(page, 'Meta Platforms, Inc.');
    await createApplication(page, 'Meta Platforms, Inc.', 'Backend Engineer');

    await gotoApps(page);
    const panel = await openDetails(page, 'Backend Engineer');
    await installFakeStorageBackend(page);

    await panel.locator('#attachment-upload-input').setInputFiles({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('pretend pdf bytes'),
    });

    // Success re-renders the panel; the toast confirms the write.
    await expect(page.locator('#toast')).toContainText(/Uploaded resume\.pdf/);
    await expect(panel.getByText('No attachments yet.')).toHaveCount(0);
    // Attachment card surfaces the original filename + the on-disk path
    // (meta_platforms_inc from the case-insensitive snake_case sanitizer).
    const card = panel.locator('li', { has: page.getByRole('button', { name: 'Download resume.pdf' }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText('meta_platforms_inc/resume.pdf');
    await expect(card).toContainText('application/pdf');

    // Verify the fake backend actually received the bytes at the expected path.
    expect(await readStoredKeys(page)).toEqual(['meta_platforms_inc/resume.pdf']);
  });

  test('second upload with the same filename gets a "(2)" suffix from the probe-first collision path', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    const panel = await openDetails(page, 'Backend Engineer');
    await installFakeStorageBackend(page);

    // First upload → stored as-is.
    await panel.locator('#attachment-upload-input').setInputFiles({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('v1'),
    });
    await expect(page.locator('#toast')).toContainText(/Uploaded resume\.pdf/);

    // Second upload of the exact same filename → coordinator probes, finds
    // "resume.pdf" taken, picks "resume (2).pdf".
    await panel.locator('#attachment-upload-input').setInputFiles({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('v2 different bytes'),
    });
    await expect(page.locator('#toast')).toContainText(/Uploaded resume \(2\)\.pdf/);

    // Both rows visible, both files on the fake backend under the same folder.
    await expect(panel.locator('li').filter({ hasText: 'alpha_co/resume.pdf' })).toBeVisible();
    await expect(panel.locator('li').filter({ hasText: 'alpha_co/resume (2).pdf' })).toBeVisible();
    expect(await readStoredKeys(page)).toEqual(
      expect.arrayContaining(['alpha_co/resume.pdf', 'alpha_co/resume (2).pdf']),
    );
  });

  test('deleting an attachment removes the row but leaves the blob untouched', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    const panel = await openDetails(page, 'Backend Engineer');
    await installFakeStorageBackend(page);

    await panel.locator('#attachment-upload-input').setInputFiles({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('pdf'),
    });
    await expect(page.locator('#toast')).toContainText(/Uploaded resume\.pdf/);
    expect(await readStoredKeys(page)).toEqual(['alpha_co/resume.pdf']);

    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: /Delete attachment resume\.pdf/ }).click();
    await expect(page.locator('#toast')).toContainText('Attachment removed');
    await expect(panel.getByText('No attachments yet.')).toBeVisible();

    // GC is deferred — the blob must still be on the backend after the row
    // was removed. Documents the "delete row, keep bytes" tradeoff.
    expect(await readStoredKeys(page)).toEqual(['alpha_co/resume.pdf']);
  });
});

test.describe('local applications page — clear all', () => {
  test('button hidden when empty, wipes apps but keeps companies when confirmed', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createCompany(page, 'Beta Co.');

    // Empty apps list → no clear-all button yet (nothing to clear).
    await gotoApps(page);
    await expect(page.locator('#btn-clear-all')).toHaveCount(0);

    await createApplication(page, 'Alpha Co.', 'Backend Engineer');
    await createApplication(page, 'Beta Co.',  'Frontend Engineer');

    await gotoApps(page);
    await expect(page.locator('#list-content li')).toHaveCount(2);
    await expect(page.locator('#btn-clear-all')).toBeEnabled();

    page.once('dialog', d => d.accept());
    await page.locator('#btn-clear-all').click();
    await expect(page.locator('#toast')).toContainText(/Cleared 2 applications/);
    await expect(page.getByText('No applications yet.')).toBeVisible();

    // Companies are the whole point — they must survive.
    await page.goto('/local/companies');
    await expect(page.locator('#list-content li', { hasText: 'Alpha Co.' })).toBeVisible();
    await expect(page.locator('#list-content li', { hasText: 'Beta Co.' })).toBeVisible();
  });

  test('cancelling the confirm dialog leaves data untouched', async ({ page }) => {
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', 'Backend Engineer');

    await gotoApps(page);
    await expect(page.locator('#list-content li')).toHaveCount(1);

    page.once('dialog', d => d.dismiss());
    await page.locator('#btn-clear-all').click();

    await expect(page.locator('#list-content li')).toHaveCount(1);
    await expect(page.locator('#toast')).not.toContainText(/Cleared/);
  });

  // A role_title flows into the list card (innerHTML), the delete button's
  // aria-label (via t() → button() which escapes), and the confirm dialog
  // (plain text). Special characters should survive all three unchanged, with
  // no visible &amp; and no HTML injection.
  test('special characters in a role title render safely across the UI', async ({ page }) => {
    const trickyRole = 'Sr. Engineer <img src=x onerror=alert(1)> & "Ops"';
    await createCompany(page, 'Alpha Co.');
    await createApplication(page, 'Alpha Co.', trickyRole);
    await gotoApps(page);

    const card = page.locator('#list-content li', { hasText: trickyRole });
    await expect(card).toBeVisible();
    await expect(card).toContainText(trickyRole);
    await expect(card.locator('img')).toHaveCount(0);
    await expect(card).not.toContainText('&amp;');

    const dialogText = await new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        const msg = dialog.message();
        dialog.dismiss();
        resolve(msg);
      });
      card.getByRole('button', { name: `Delete ${trickyRole}` }).click();
    });
    expect(dialogText).toContain(trickyRole);
    expect(dialogText).not.toContain('&amp;');
    expect(dialogText).not.toContain('&lt;');
    expect(dialogText).not.toContain('&quot;');
  });
});
