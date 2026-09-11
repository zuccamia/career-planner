// BYOK variant for summarize-thread + generate-message via the threads panel.

import { expect, test, type Page } from './fixtures';
import { enableBYOK, interceptBYOKLLM, scriptedBYOKResponder } from './byok-fixtures';

const gotoPeople = async (page: Page) => {
  await page.goto('/people');
  // Wait for the client-mounted button — SSR text renders before initDb().
  await expect(page.getByRole('button', { name: 'Add person' })).toBeVisible({ timeout: 30_000 });
};

// One thread + one entry — both LLM buttons need at least one entry to enable.
const seedPersonAndThread = async (page: Page) => {
  await gotoPeople(page);
  return page.evaluate(async () => {
    const [{ createPerson }, { createThread, createEntry }] = await Promise.all([
      import('/static/js/entities/people.mjs'),
      import('/static/js/entities/people.mjs'),
    ]);
    const personId = await createPerson({ full_name: 'Ada Lovelace', title: 'Engineer' });
    const threadId = await createThread({
      person_id: personId, channel: 'email', subject: 'Intro chat', status: 'open',
    });
    await createEntry({
      thread_id: threadId, direction: 'inbound',
      content: 'Hi Ada, would you have time next week for a chat about the intern program?',
    });
    return { personId, threadId };
  });
};

test.describe('people flows — BYOK', () => {
  test('Summarize thread runs the JS summarize-thread handler through BYOK', async ({ page }) => {
    await seedPersonAndThread(page);
    await gotoPeople(page);
    await enableBYOK(page);
    const { calls } = await interceptBYOKLLM(page, scriptedBYOKResponder([
      { content: JSON.stringify({ summary: 'Intro request; Ada open to a chat next week.' }) },
    ]));

    await page.locator('#list-content li', { hasText: 'Ada Lovelace' })
      .getByRole('button', { name: /Open Ada Lovelace/ }).click();
    // Expand the seeded thread — Summarize + Draft controls live inside the
    // thread detail, hidden until the row is opened.
    await page.locator('#threads-panel .js-toggle-thread').first().click();
    await page.locator('#btn-summarize').click();
    await expect(page.locator('#toast')).toContainText(/Summary saved|saved/i, { timeout: 15_000 });

    expect(calls).toHaveLength(1);
    const userMessage = calls[0].messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('Ada');
  });

  test('Draft outreach runs the JS generate-message handler through BYOK', async ({ page }) => {
    await seedPersonAndThread(page);
    await gotoPeople(page);
    await enableBYOK(page);
    const { calls } = await interceptBYOKLLM(page, scriptedBYOKResponder([
      { content: JSON.stringify({ message: 'Hi Ada, thanks for reaching out — Tuesday 3pm works well.' }) },
    ]));

    await page.locator('#list-content li', { hasText: 'Ada Lovelace' })
      .getByRole('button', { name: /Open Ada Lovelace/ }).click();
    await page.locator('#threads-panel .js-toggle-thread').first().click();
    await page.locator('#btn-generate-outreach').click();
    // Draft panel renders with the LLM-generated message text.
    await expect(page.locator('#draft-panel')).toContainText('Tuesday 3pm', { timeout: 15_000 });

    expect(calls).toHaveLength(1);
    const userMessage = calls[0].messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('outreach');
  });
});
