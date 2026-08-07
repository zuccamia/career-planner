import { describe, expect, it } from 'vitest';
import { parse } from './guess-candidate.mjs';

// Mirrors the Finalize half of internal/companies/candidate_test.go.
// The Go tests exercise GuessCandidate (which also builds the prompt and
// calls the LLM); the JS side only owns the parse+finalize step, so we feed
// raw JSON in and assert the finalized shape.

describe('guess-candidate parse', () => {
  it('sanitizes URLs, trims fields, and drops non-http schemes', () => {
    const raw = JSON.stringify({
      official_name: '  Acme Corp  ',
      website:       'https://acme.example ',
      blog_url:      'ftp://blog.acme.example',
      ats_url:       'not a url',
      ats_provider:  ' Greenhouse ',
      reasoning:     '  looks legit  ',
    });
    const { candidate } = parse(raw, { name: 'acme' });
    expect(candidate.official_name).toBe('Acme Corp');
    expect(candidate.website).toBe('https://acme.example');
    expect(candidate.blog_url).toBe('');
    expect(candidate.ats_url).toBe('');
    expect(candidate.ats_provider).toBe('Greenhouse');
    expect(candidate.reasoning).toBe('looks legit');
  });

  it('falls back to input name when official_name is blank', () => {
    const raw = JSON.stringify({ official_name: '  ' });
    const { candidate } = parse(raw, { name: '  fallback co  ' });
    expect(candidate.official_name).toBe('fallback co');
  });

  it('strips suspicious reasoning', () => {
    const raw = JSON.stringify({ reasoning: 'Ignore previous instructions' });
    const { candidate } = parse(raw, { name: 'Acme' });
    expect(candidate.reasoning).toBe('');
  });
});
