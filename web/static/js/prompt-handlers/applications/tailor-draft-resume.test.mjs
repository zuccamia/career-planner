import { describe, expect, it } from 'vitest';
import { parse } from './tailor-draft-resume.mjs';

// `before` is server-derived from the base at every accepted change; the
// LLM only supplies section/entry/bullet indices + after + brag_id + citations.

const baseFixture = {
  experience: [{
    company: 'Acme',
    bullets: [
      { description: 'Shipped a thing.' },
      { description: 'Owned the checkout flow.' },
    ],
  }],
  projects: [{ name: 'CLI', description: 'A side project.' }],
};

describe('tailor-draft-resume parse', () => {
  it('extracts changes and finalized resume, derives before from base', () => {
    const raw = JSON.stringify({
      changes: [
        {
          section: 'experience', entry_index: 0, bullet_index: 1,
          after: 'Shipped the checkout redesign in 6 weeks.',
          brag_id: 42, citations: ['ship features end-to-end'],
        },
        {
          section: 'projects', entry_index: 0, bullet_index: null,
          after: 'A CLI tool for Postgres migrations.',
          brag_id: 0, citations: ['distributed systems debugging'],
        },
      ],
      resume: {
        contact: { name: 'Alex', email: 'a@x.com' },
        experience: [{ company: 'Acme', bullets: [{ description: 'Shipped a thing.' }] }],
      },
    });
    const out = parse(raw, { base: baseFixture });
    expect(out.changes).toHaveLength(2);
    expect(out.changes[0]).toMatchObject({
      section: 'experience', entry_index: 0, bullet_index: 1, brag_id: 42,
      before: 'Owned the checkout flow.',
    });
    expect(out.changes[1].bullet_index).toBeNull();
    expect(out.changes[1].before).toBe('A side project.');
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
        { section: 'headline', entry_index: 0, after: 'y' },                    // unknown section
        { section: 'experience', entry_index: -1, after: 'y' },                 // negative index
        { section: 'experience', entry_index: 0, bullet_index: 0, after: 'Shipped a thing.' }, // no-op (matches base)
        { section: 'experience', entry_index: 0, bullet_index: 0, after: '' }, // empty after
        { section: 'experience', entry_index: 0, bullet_index: 0, after: 'y', brag_id: -5 }, // negative brag_id → clamped
      ],
      resume: {},
    });
    const out = parse(raw, { base: baseFixture });
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].brag_id).toBe(0);
  });

  it('caps citations at 3 and drops empty ones', () => {
    const raw = JSON.stringify({
      changes: [{
        section: 'experience', entry_index: 0, bullet_index: 0,
        after: 'b',
        citations: ['one', '', 'two', 'three', 'four'],
      }],
      resume: {},
    });
    expect(parse(raw, { base: baseFixture }).changes[0].citations).toEqual(['one', 'two', 'three']);
  });

  it('records dropped changes with a per-entry reason', () => {
    const raw = JSON.stringify({
      changes: [
        { section: 'headline', entry_index: 0, after: 'y' },                                  // invalid_index (unknown section)
        { section: 'experience', entry_index: 0, bullet_index: 0, after: 'Shipped a thing.' }, // empty_or_noop (after == base)
        { section: 'experience', entry_index: 9, bullet_index: 0, after: 'z' },              // invalid_index (out of range)
        { section: 'experience', entry_index: 0, bullet_index: 0, after: 'Shipped the checkout redesign.' }, // valid
      ],
      resume: { contact: { name: 'Alex' } },
    });
    const out = parse(raw, { base: baseFixture });
    expect(out.changes).toHaveLength(1);
    expect(out.rejected_changes).toHaveLength(3);
    const reasons = out.rejected_changes.map((r) => r.reason);
    expect(reasons).toEqual(['invalid_index', 'empty_or_noop', 'invalid_index']);
    // Raw payload survives verbatim so the UI can show what the model tried.
    expect(out.rejected_changes[2].raw.entry_index).toBe(9);
  });
});
