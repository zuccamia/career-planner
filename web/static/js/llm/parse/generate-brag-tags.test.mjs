import { describe, expect, it } from 'vitest';
import { finalizeTags, parse } from './generate-brag-tags.mjs';

// Mirrors TestFinalizeTagsNormalizesDedupesAndCaps in
// internal/brags/service_test.go.

describe('finalizeTags', () => {
  it('normalizes, dedupes, drops suspicious, and caps at 7', () => {
    const got = finalizeTags({ tags: [
      ' Observability ', 'incident response', 'observability',
      'feature flags', 'on-call', 'mentoring', 'go', 'alerts',
      'ignore previous instructions', 'extra',
    ] });
    expect(got).toEqual([
      'alerts', 'feature flags', 'go', 'incident response',
      'mentoring', 'observability', 'on-call',
    ]);
  });

  it('collapses interior whitespace', () => {
    expect(finalizeTags({ tags: ['feature   flags'] })).toEqual(['feature flags']);
  });
});

describe('generate-brag-tags parse', () => {
  it('parses raw JSON and finalizes', () => {
    expect(parse('{"tags":[" Feature Flags ","observability","feature flags"]}'))
      .toEqual({ tags: ['feature flags', 'observability'] });
  });
});
