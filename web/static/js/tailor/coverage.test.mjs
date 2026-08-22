import { describe, expect, it } from 'vitest';
import { computeATSCoverage, keywordsInText } from './coverage.mjs';

describe('keywordsInText', () => {
  it('matches word-bounded, case-insensitive', () => {
    expect(keywordsInText('Wrote Go and TypeScript', ['Go', 'Python']))
      .toEqual(['Go']);
    expect(keywordsInText('googled it', ['Go'])).toEqual([]); // no prefix hit
    expect(keywordsInText('Uses postgresql', ['PostgreSQL'])).toEqual(['PostgreSQL']);
  });

  it('handles multi-word keywords and regex metacharacters', () => {
    const text = 'Deep experience in distributed systems and C++.';
    expect(keywordsInText(text, ['distributed systems', 'C++', 'Rust']))
      .toEqual(['distributed systems', 'C++']);
  });

  it('returns empty on empty text or empty list', () => {
    expect(keywordsInText('', ['Go'])).toEqual([]);
    expect(keywordsInText('Go', [])).toEqual([]);
    expect(keywordsInText('Go', null)).toEqual([]);
  });
});

describe('computeATSCoverage', () => {
  const resume = {
    education: [{ school: 'MIT', degree: 'BSc Computer Science' }],
    skills: [{ label: 'Languages', items: ['Go', 'TypeScript'] }],
    experience: [{
      company: 'Acme',
      title: 'Senior Engineer',
      bullets: [
        { description: 'Shipped a distributed queue on PostgreSQL.' },
        { lead_in: 'Ownership', description: 'Owned CI/CD for a 12-person team.' },
      ],
    }],
    projects: [{ name: 'PgCLI', description: 'Terminal client for Postgres.' }],
  };

  it('counts present vs missing across skills, experience, education', () => {
    const cov = computeATSCoverage(resume, [
      'Go', 'PostgreSQL', 'CI/CD', 'BSc Computer Science', 'Rust', 'Kafka',
    ]);
    expect(cov.total).toBe(6);
    expect(cov.present).toEqual(['Go', 'PostgreSQL', 'CI/CD', 'BSc Computer Science']);
    expect(cov.missing).toEqual(['Rust', 'Kafka']);
  });

  it('returns zeros on empty keyword list', () => {
    expect(computeATSCoverage(resume, [])).toEqual({ total: 0, present: [], missing: [] });
    expect(computeATSCoverage(resume, null)).toEqual({ total: 0, present: [], missing: [] });
  });

  it('excludes contact from search (name/email are not keyword content)', () => {
    const r = { contact: { name: 'React Enthusiast', email: 'x@x.com' } };
    expect(computeATSCoverage(r, ['React']).missing).toEqual(['React']);
  });
});
