// Smoke-tests each flow's build() end-to-end against the real prompt JSON on
// disk. Vitest runs in Node and this project's fetch() is browser-native,
// so we stub it with a fs-backed shim that resolves the same paths the
// browser would hit at /static/i18n/prompts/{module}/{name}.{locale}.json.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builders } from './index.mjs';
import { build as buildRank } from './applications/tailor-rank-brags.mjs';
import { build as buildDraft } from './applications/tailor-draft-resume.mjs';
import { _resetPromptCacheForTests } from '../sources/llm/prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is web/static/js/prompt-handlers — four levels below the repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
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
  'companies/lookup':                      { name: 'Acme Corp' },
  'companies/build-dossier':                        { official_name: 'Acme Corp' },
  'profile/generate-brag-tags':                   { body: 'Shipped feature flags to production.' },
  'profile/import-brags':                          { markdown: '# CV\n- did stuff' },
  'profile/import-overview':               { markdown: '# CV\n- did stuff' },
  'profile/import-resume':                 { markdown: '# CV\n- did stuff' },
  'people/summarize-thread': {
    thread:  { person_name: 'Jane', channel: 'email', subject: 'hi', status: 'open', summary: '' },
    entries: [{ direction: 'inbound', content: 'hi there', occurred_at: '2026-01-02T03:04:05Z' }],
  },
  'people/generate-message': {
    goal: 'outreach',
    thread:  { person_name: 'Jane', channel: 'email', subject: 'hi', status: 'open', summary: '' },
    entries: [],
  },
  'applications/extract-job-description': {
    company_name: 'Acme', role_title: 'Engineer',
    job_description_raw: 'We are hiring an engineer to build things.',
  },
  'applications/analyze-role-signals': {
    jd_structured: { role_title: 'Engineer', must_have_skills: ['Go'] },
    company_dossier: null,
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
        if (name === 'companies/lookup')                     expect(out.user).toContain('Acme Corp');
        if (name === 'profile/generate-brag-tags')                  expect(out.user).toContain('Shipped feature flags');
        if (name === 'applications/extract-job-description') expect(out.user).toContain('We are hiring');
        if (name === 'companies/build-dossier')                       expect(out.user).toContain('Acme Corp');
        if (name === 'people/summarize-thread')      expect(out.user).toContain('Person: Jane');
        if (name === 'people/generate-message')      expect(out.user).toContain('outreach');
      }
    });
  }
});

// Rank + draft flows aren't in the registry (composed by tailor-client.mjs
// directly), but their persona rendering — the leading %s slot in system,
// resolved from JD.function with a "professional" fallback — is worth
// pinning here since the fetch stub is already set up.
describe('tailor persona rendering', () => {
  const cases = [
    { name: 'rank',  build: buildRank,  probe: 'résumé strategist',
      min: {
        jd_structured:          { role_title: 'Engineer' },
        profile:                { name: 'Alex' },
        base_resume_structured: { contact: { name: 'Alex' }, experience: [{ company: 'A', bullets: [{ description: 'X' }] }] },
        brags:                  [{ id: 1, title: 'X', body: 'Y', tags: [] }],
      } },
    { name: 'draft', build: buildDraft, probe: 'senior hiring manager',
      min: {
        jd_structured:          { role_title: 'Engineer' },
        profile:                { name: 'Alex' },
        base_resume_structured: { contact: { name: 'Alex' }, experience: [] },
        experience_brags: [], project_brags: [], activity_brags: [],
      } },
  ];

  for (const { name, build, probe, min } of cases) {
    it(`${name} interpolates jd.function`, async () => {
      const input = { ...min, jd_structured: { ...min.jd_structured, function: 'product management' } };
      const { system } = await build(input, 'en');
      expect(system).toContain(probe);
      expect(system).toContain('product management');
      expect(system).not.toContain('professional');
    });
    it(`${name} falls back to "professional" when jd.function is empty`, async () => {
      const { system } = await build(min, 'en');
      expect(system).toContain(probe);
      expect(system).toContain('professional');
    });
  }
});

describe('builders reject invalid input', () => {
  it('companies/lookup throws on empty name', async () => {
    await expect(builders['companies/lookup']({ name: '  ' }, 'en')).rejects.toThrow(/name is required/);
  });
  it('profile/generate-brag-tags throws on empty body', async () => {
    await expect(builders['profile/generate-brag-tags']({ body: '' }, 'en')).rejects.toThrow(/body is required/);
  });
  it('profile/import-brags throws on empty markdown', async () => {
    await expect(builders['profile/import-brags']({ markdown: '' }, 'en')).rejects.toThrow(/markdown is required/);
  });
  it('companies/build-dossier throws on empty official_name', async () => {
    await expect(builders['companies/build-dossier']({ official_name: '' }, 'en')).rejects.toThrow(/official_name is required/);
  });
  it('people/generate-message throws on invalid goal', async () => {
    await expect(builders['people/generate-message']({ goal: 'chitchat', thread: {}, entries: [] }, 'en'))
      .rejects.toThrow(/invalid communication goal/);
  });
  it('applications/extract-job-description throws on empty raw', async () => {
    await expect(builders['applications/extract-job-description']({ job_description_raw: '' }, 'en'))
      .rejects.toThrow(/job description is required/);
  });
});
