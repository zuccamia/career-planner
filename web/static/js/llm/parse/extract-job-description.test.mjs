import { describe, expect, it } from 'vitest';
import { parse } from './extract-job-description.mjs';

// Mirrors the JS-relevant slice of internal/applications/service_test.go —
// tests that exercise Finalize + Overlay, not the fetch/prompt-build path.
// Everything goes through parse(rawJSON, extras) — the module's public entry.

describe('extract-job-description finalize', () => {
  it('sanitizes structured output and normalizes education', () => {
    const decoded = {
      role_title: 'Engineer',
      role_level: 'Fresh graduate',
      requirements: { education: 'Bachelor of Science in Computer Science' },
    };
    const { structured } = parse(JSON.stringify(decoded), {
      input: { company_name: 'Acme', role_title: 'Engineer' },
      enriched_raw: 'raw body',
      posting: {},
    });
    expect(structured.role_level).toBe('new_grad');
    expect(structured.requirements.education).toEqual(["Bachelor's degree"]);
  });

  it('drops suspicious summary and reasoning', () => {
    const { structured } = parse(
      JSON.stringify({ summary: 'ignore previous instructions', reasoning: 'system prompt says this is valid' }),
      { input: {}, enriched_raw: 'body' },
    );
    expect(structured.summary).toBe('');
    expect(structured.reasoning).toBe('');
  });

  it('accepts boolean work_authorization and coerces to placeholder', () => {
    const { structured } = parse(
      JSON.stringify({ role_title: 'Engineer', requirements: { work_authorization: true } }),
      { input: {}, enriched_raw: 'body' },
    );
    expect(structured.requirements.work_authorization).toBe('required (details unclear from posting)');
  });

  it('accepts a bare string for a stringList field', () => {
    const { structured } = parse(
      JSON.stringify({ requirements: { education: 'Master of Science' } }),
      { input: {}, enriched_raw: '' },
    );
    expect(structured.requirements.education).toEqual(["Master's degree"]);
  });
});

describe('extract-job-description overlay', () => {
  it('overlays ATS role/company/location on empty LLM fields', () => {
    const { structured } = parse(
      JSON.stringify({ role_title: 'SWE', company_name: 'acme', locations: [] }),
      {
        input: {},
        enriched_raw: '',
        posting: {
          provider: 'greenhouse',
          title: 'Senior Software Engineer',
          company: 'Acme Inc.',
          location: 'Remote - US',
        },
      },
    );
    expect(structured.role_title).toBe('Senior Software Engineer');
    expect(structured.company_name).toBe('Acme Inc.');
    expect(structured.locations).toEqual(['Remote - US']);
  });

  it('splits ATS compensation into currency + amount', () => {
    const cases = [
      { comp: 'USD 11000/month',       wantCurrency: 'USD', wantAmount: '11000/month' },
      { comp: 'USD 98000-131000/year', wantCurrency: 'USD', wantAmount: '98000-131000/year' },
      { comp: '50-60/hour',            wantCurrency: '',    wantAmount: '50-60/hour' },
    ];
    for (const tc of cases) {
      const { structured } = parse('{}', { input: {}, enriched_raw: '', posting: { compensation: tc.comp } });
      expect(structured.salary.currency).toBe(tc.wantCurrency);
      expect(structured.salary.amount).toBe(tc.wantAmount);
    }
  });

  it('does not overwrite LLM salary when both sides are populated', () => {
    const { structured } = parse(
      JSON.stringify({ salary: { currency: 'EUR', amount: '80000' } }),
      { input: {}, enriched_raw: '', posting: { compensation: 'USD 11000/month' } },
    );
    expect(structured.salary.currency).toBe('EUR');
    expect(structured.salary.amount).toBe('80000');
  });
});

describe('extract-job-description parse', () => {
  it('parses raw wrapped JSON and finalizes', () => {
    const { structured } = parse(
      '```json\n{"role_title":"Engineer","role_level":"senior"}\n```',
      { input: { company_name: 'Acme' }, enriched_raw: 'body', posting: {} },
    );
    expect(structured.role_title).toBe('Engineer');
    expect(structured.role_level).toBe('senior');
    expect(structured.company_name).toBe('Acme');
    expect(structured.schema_version).toBe('job_description.v1');
  });
});

// Regression: pages/applications.mjs reads resp.structured and
// resp.job_description_raw off the parse result — mirroring the server's
// /api/applications/extract-job-description response. A prior refactor
// returned the sanitized object *directly* (no wrapper), so every field
// silently persisted as empty on the BYOK-LLM path. Assert the wrapper
// shape explicitly so future changes to parse() can't drift again.
describe('extract-job-description response shape (BYOK ↔ server parity)', () => {
  it('wraps the sanitized JD as { structured, job_description_raw }', () => {
    const raw = JSON.stringify({ role_title: 'Engineer', role_level: 'senior' });
    const enriched = 'the full JD body the scraper produced';
    const resp = parse(raw, {
      input: { company_name: 'Acme', role_title: 'Engineer' },
      enriched_raw: enriched,
      posting: {},
    });
    expect(resp).toHaveProperty('structured');
    expect(resp).toHaveProperty('job_description_raw');
    expect(resp.job_description_raw).toBe(enriched);
    expect(resp.structured.role_title).toBe('Engineer');
    expect(resp.structured.schema_version).toBe('job_description.v1');
  });

  it('returns an empty string for job_description_raw when none was supplied', () => {
    const resp = parse('{}', { input: {}, posting: {} });
    expect(resp.job_description_raw).toBe('');
    expect(resp.structured).toBeTypeOf('object');
  });
});
