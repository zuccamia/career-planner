import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './tailor-with-tools.mjs';

describe('tailor-with-tools parse', () => {
  it('delegates to tailor-draft-resume parse', () => {
    const raw = JSON.stringify({
      changes: [{
        section: 'experience', entry_index: 0, bullet_index: 0,
        before: 'Shipped a thing.', after: 'Shipped checkout.',
        brag_id: 7, citations: ['ship end-to-end'],
      }],
      resume: { contact: { name: 'A' } },
    });
    const out = parse(raw);
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].brag_id).toBe(7);
    expect(out.resume.contact.name).toBe('A');
  });

  it('tolerates markdown fences around the JSON', () => {
    const raw = '```json\n' + JSON.stringify({ resume: { contact: { name: 'B' } } }) + '\n```';
    expect(parse(raw).resume.contact.name).toBe('B');
  });
});

// Verifies the on-disk schema shape both Go and JS consume. Reads the file
// directly so any drift in required arg names or enum values fails here.
describe('tailor-with-tools schema on disk', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SCHEMA_DIR = resolve(HERE, '..', '..', '..', '..', '..', 'web', 'static', 'tool-schemas');
  let realFetch;
  beforeAll(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      const m = /\/static\/tool-schemas\/(.+\.json)$/.exec(String(url));
      if (!m) throw new Error(`unexpected fetch: ${url}`);
      const path = join(SCHEMA_DIR, m[1]);
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path, 'utf8')) };
    });
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  it('exposes get_brags, search_brags, and search_resumes with the expected required params', async () => {
    const { loadToolSchema } = await import('../../sources/llm/tool-schemas.mjs');
    const tools = await loadToolSchema('applications/tailor-with-tools');
    const byName = Object.fromEntries(tools.map((t) => [t.function.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['get_brags', 'search_brags', 'search_resumes']);
    expect(byName.get_brags.function.parameters.required).toContain('ids');
    expect(byName.search_brags.function.parameters.required).toContain('query');
    expect(byName.search_resumes.function.parameters.required).toContain('query');
  });

  it('restricts search_brags.category to the three résumé sections', async () => {
    const { loadToolSchema } = await import('../../sources/llm/tool-schemas.mjs');
    const tools = await loadToolSchema('applications/tailor-with-tools');
    const searchBrags = tools.find((t) => t.function.name === 'search_brags');
    expect(searchBrags.function.parameters.properties.category.enum)
      .toEqual(['experience', 'project', 'activity']);
  });

  it('caps get_brags.ids at 8 items to keep the tool focused on cited brags', async () => {
    const { loadToolSchema } = await import('../../sources/llm/tool-schemas.mjs');
    const tools = await loadToolSchema('applications/tailor-with-tools');
    const getBrags = tools.find((t) => t.function.name === 'get_brags');
    expect(getBrags.function.parameters.properties.ids.maxItems).toBe(8);
  });
});
