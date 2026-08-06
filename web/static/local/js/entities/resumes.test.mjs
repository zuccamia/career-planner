import { describe, expect, it } from 'vitest';
import { resumePdfFilename } from './resumes.mjs';

describe('resumePdfFilename', () => {
  // Use local-time constructor so tests are deterministic across timezones —
  // an ISO string near midnight UTC would stamp differently depending on
  // where the test host lives.
  const fixedDate = new Date(2026, 7, 4, 12, 0, 0);

  it('uses name + CV + YYYYMMDD when name is present', () => {
    expect(resumePdfFilename({ name: 'Ada Lovelace', date: fixedDate }))
      .toBe('Ada Lovelace - CV - 20260804.pdf');
  });

  it('trims surrounding whitespace on the name', () => {
    expect(resumePdfFilename({ name: '  Ada Lovelace  ', date: fixedDate }))
      .toBe('Ada Lovelace - CV - 20260804.pdf');
  });

  it('falls back to the provided title when name is empty', () => {
    expect(resumePdfFilename({ name: '', fallback: 'Draft résumé', date: fixedDate }))
      .toBe('Draft résumé.pdf');
  });

  it('falls back to "resume" when both name and fallback are empty', () => {
    expect(resumePdfFilename({ date: fixedDate })).toBe('resume.pdf');
  });

  it('strips filesystem-hostile characters', () => {
    expect(resumePdfFilename({ name: 'Ada/Lovelace?:*<>|"', date: fixedDate }))
      .toBe('AdaLovelace - CV - 20260804.pdf');
  });

  it('leaves unicode and dashes intact', () => {
    expect(resumePdfFilename({ name: 'Nguyễn Bích Ngọc', date: fixedDate }))
      .toBe('Nguyễn Bích Ngọc - CV - 20260804.pdf');
  });

  it('defaults to today when date is omitted', () => {
    const out = resumePdfFilename({ name: 'X' });
    expect(out).toMatch(/^X - CV - \d{8}\.pdf$/);
  });

  it('rejects a fully-invalid name and falls through to "resume"', () => {
    // Only-slashes name → stripped to empty → falls back.
    expect(resumePdfFilename({ name: '///', date: fixedDate }))
      .toBe('resume.pdf');
  });
});
