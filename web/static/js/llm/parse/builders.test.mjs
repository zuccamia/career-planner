// Smoke-tests each flow's build() end-to-end against the real prompt JSON on
// disk. Vitest runs in Node and this project's fetch() is browser-native,
// so we stub it with a fs-backed shim that resolves the same paths the
// browser would hit at /static/i18n/prompts/{name}.{locale}.json.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builders } from './index.mjs';
import { _resetPromptCacheForTests } from '../prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is web/static/js/llm/parse — five levels below the repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const PROMPTS_DIR = join(REPO_ROOT, 'web', 'static', 'i18n', 'prompts');

let realFetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url) => {
    const m = /\/static\/i18n\/prompts\/(.+\.json)$/.exec(String(url));
    if (!m) throw new Error(`unexpected fetch: ${url}`);
    const path = join(PROMPTS_DIR, m[1]);
    if (!existsSync(path)) return { ok: false, status: 404 };
    const body = readFileSync(path, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  });
});
afterAll(() => {
  globalThis.fetch = realFetch;
  _resetPromptCacheForTests();
});

// Minimum valid input per flow — chosen to satisfy the required-field checks
// without exercising every optional path.
const MINIMUM_INPUT = {
  'guess-candidate':                   { name: 'Acme Corp' },
  'build-dossier':                     { official_name: 'Acme Corp' },
  'generate-brag-tags':                { body: 'Shipped feature flags to production.' },
  'extract-brags-from-resume':         { markdown: '# CV\n- did stuff' },
  'extract-overview-from-resume':      { markdown: '# CV\n- did stuff' },
  'extract-structured-resume-from-md': { markdown: '# CV\n- did stuff' },
  'summarize-thread': {
    thread:  { person_name: 'Jane', channel: 'email', subject: 'hi', status: 'open', summary: '' },
    entries: [{ direction: 'inbound', content: 'hi there', occurred_at: '2026-01-02T03:04:05Z' }],
  },
  'generate-message': {
    goal: 'outreach',
    thread:  { person_name: 'Jane', channel: 'email', subject: 'hi', status: 'open', summary: '' },
    entries: [],
  },
  'extract-job-description': {
    company_name: 'Acme', role_title: 'Engineer',
    job_description_raw: 'We are hiring an engineer to build things.',
  },
};

describe('builders smoke', () => {
  it('has one builder per parser', () => {
    // parse/index.mjs asserts modules match — this checks the entry cardinality.
    expect(Object.keys(builders).sort()).toEqual(Object.keys(MINIMUM_INPUT).sort());
  });

  for (const [name, input] of Object.entries(MINIMUM_INPUT)) {
    it(`${name} assembles a non-empty prompt for both locales`, async () => {
      for (const locale of ['en', 'vi']) {
        const out = await builders[name](input, locale);
        expect(out.system).toBeTruthy();
        expect(out.user).toBeTruthy();
        // Verify the input actually made it into the interpolated user text.
        // For flows with a single string input, we can check directly.
        if (name === 'guess-candidate')      expect(out.user).toContain('Acme Corp');
        if (name === 'generate-brag-tags')   expect(out.user).toContain('Shipped feature flags');
        if (name === 'extract-job-description') expect(out.user).toContain('We are hiring');
        if (name === 'build-dossier')        expect(out.user).toContain('Acme Corp');
        if (name === 'summarize-thread')     expect(out.user).toContain('Person: Jane');
        if (name === 'generate-message')     expect(out.user).toContain('outreach');
      }
    });
  }
});

describe('builders reject invalid input', () => {
  it('guess-candidate throws on empty name', async () => {
    await expect(builders['guess-candidate']({ name: '  ' }, 'en')).rejects.toThrow(/name is required/);
  });
  it('generate-brag-tags throws on empty body', async () => {
    await expect(builders['generate-brag-tags']({ body: '' }, 'en')).rejects.toThrow(/body is required/);
  });
  it('extract-brags-from-resume throws on empty markdown', async () => {
    await expect(builders['extract-brags-from-resume']({ markdown: '' }, 'en')).rejects.toThrow(/markdown is required/);
  });
  it('build-dossier throws on empty official_name', async () => {
    await expect(builders['build-dossier']({ official_name: '' }, 'en')).rejects.toThrow(/official_name is required/);
  });
  it('generate-message throws on invalid goal', async () => {
    await expect(builders['generate-message']({ goal: 'chitchat', thread: {}, entries: [] }, 'en'))
      .rejects.toThrow(/invalid communication goal/);
  });
  it('extract-job-description throws on empty raw', async () => {
    await expect(builders['extract-job-description']({ job_description_raw: '' }, 'en'))
      .rejects.toThrow(/job description is required/);
  });
});
