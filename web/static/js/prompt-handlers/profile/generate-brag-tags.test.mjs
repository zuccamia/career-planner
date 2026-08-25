import { describe, expect, it } from 'vitest';
import { finalizeBragTags, parse } from './generate-brag-tags.mjs';

// Mirrors TestFinalizeBragTagsNormalizesDedupesAndCaps in
// internal/profile/service_test.go.

describe('finalizeBragTags', () => {
  it('normalizes, dedupes, drops suspicious, and caps at 7', () => {
    const got = finalizeBragTags({ tags: [
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
    expect(finalizeBragTags({ tags: ['feature   flags'] })).toEqual(['feature flags']);
  });
});

describe('generate-brag-tags parse', () => {
  it('parses raw JSON and finalizes', () => {
    expect(parse('{"tags":[" Feature Flags ","observability","feature flags"]}'))
      .toEqual({ tags: ['feature flags', 'observability'] });
  });
});
