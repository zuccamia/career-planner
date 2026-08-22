import { describe, expect, it } from 'vitest';
import { parse } from './tailor-draft-resume.mjs';

describe('tailor-draft-resume parse', () => {
  it('extracts changes and finalized resume', () => {
    const raw = JSON.stringify({
      changes: [
        {
          section: 'experience', entry_index: 0, bullet_index: 1,
          before: 'Shipped a thing.', after: 'Shipped the checkout redesign in 6 weeks.',
          brag_id: 42, citations: ['ship features end-to-end'],
        },
        {
          section: 'projects', entry_index: 0, bullet_index: null,
          before: 'A side project.', after: 'A CLI tool for Postgres migrations.',
          brag_id: 0, citations: ['distributed systems debugging'],
        },
      ],
      resume: {
        contact: { name: 'Alex', email: 'a@x.com' },
        experience: [{ company: 'Acme', bullets: [{ description: 'Shipped a thing.' }] }],
      },
    });
    const out = parse(raw);
    expect(out.changes).toHaveLength(2);
    expect(out.changes[0]).toMatchObject({
      section: 'experience', entry_index: 0, bullet_index: 1, brag_id: 42,
    });
    expect(out.changes[1].bullet_index).toBeNull();
    expect(out.resume.contact.name).toBe('Alex');
  });

  it('drops any summary the model emits — the résumé template has no summary section', () => {
    const raw = JSON.stringify({
      resume: {
        contact: { name: 'X' },
        summary: 'a stray summary the model emitted',
      },
    });
    expect(parse(raw).resume.summary).toBeUndefined();
  });

  it('tolerates missing fields', () => {
    const out = parse('{}');
    expect(out.changes).toEqual([]);
    expect(out.resume.contact).toEqual({ name: '' });
  });

  it('drops invalid change entries', () => {
    const raw = JSON.stringify({
      changes: [
        { section: 'headline', entry_index: 0, before: 'x', after: 'y' },      // unknown section
        { section: 'experience', entry_index: -1, before: 'x', after: 'y' },   // negative index
        { section: 'experience', entry_index: 0, before: 'x', after: 'x' },    // no-op
        { section: 'experience', entry_index: 0, before: '', after: 'y' },     // empty before
        { section: 'experience', entry_index: 0, before: 'x', after: 'y', brag_id: -5 }, // negative brag_id → clamped to 0
      ],
      resume: {},
    });
    const out = parse(raw);
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].brag_id).toBe(0);
  });

  it('caps citations at 3 and drops empty ones', () => {
    const raw = JSON.stringify({
      changes: [{
        section: 'experience', entry_index: 0, bullet_index: 0,
        before: 'a', after: 'b',
        citations: ['one', '', 'two', 'three', 'four'],
      }],
      resume: {},
    });
    expect(parse(raw).changes[0].citations).toEqual(['one', 'two', 'three']);
  });
});

