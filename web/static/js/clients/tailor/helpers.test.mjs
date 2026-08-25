import { describe, expect, it } from 'vitest';
import { computeATSCoverage, exceedsOnePage, keywordsInText } from './helpers.mjs';

// ---- budget ----

describe('exceedsOnePage', () => {
  const base = {
    experience: [
      { company: 'A', bullets: [{ description: 'b1' }, { description: 'b2' }] },
      { company: 'B', bullets: [{ description: 'b3' }] },
    ],
    skills: [{ label: 'lang', items: ['Go'] }, { label: 'infra', items: ['K8s'] }],
  };

  it('returns false when the tailored output stays within base counts', () => {
    const tailored = {
      experience: [
        { company: 'A', bullets: [{ description: 'x' }, { description: 'y' }] },
        { company: 'B', bullets: [{ description: 'z' }] },
      ],
      skills: [{ label: 'lang', items: ['Go'] }, { label: 'infra', items: ['K8s'] }],
    };
    expect(exceedsOnePage(tailored, base)).toBe(false);
  });

  it('flags overflow on extra roles, extra bullets, or extra skill groups', () => {
    expect(exceedsOnePage({ experience: [...base.experience, { company: 'C', bullets: [] }], skills: base.skills }, base)).toBe(true);
    expect(exceedsOnePage({
      experience: [{ company: 'A', bullets: [{ description: 'x' }, { description: 'y' }, { description: 'extra' }] }, base.experience[1]],
      skills: base.skills,
    }, base)).toBe(true);
    expect(exceedsOnePage({ experience: base.experience, skills: [...base.skills, { label: 'extra', items: [] }] }, base)).toBe(true);
  });

  it('flags overflow on extra projects or activities', () => {
    const baseWithSide = { ...base, projects: [{ name: 'p1' }], activities: [{ name: 'a1' }] };
    expect(exceedsOnePage({ ...baseWithSide, projects: [{ name: 'p1' }, { name: 'p2' }] }, baseWithSide)).toBe(true);
    expect(exceedsOnePage({ ...baseWithSide, activities: [{ name: 'a1' }, { name: 'a2' }] }, baseWithSide)).toBe(true);
  });
});

// ---- coverage ----

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
