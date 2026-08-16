import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../i18n.mjs', () => ({
  t: (key, params = {}) => {
    const dict = {
      'common.age.just_now': 'just now',
      'common.age.hour_one': '1 hour ago',
      'common.age.hour_many': `${params.n} hours ago`,
      'common.age.day_one': '1d ago',
      'common.age.day_many': `${params.n}d ago`,
      'common.age.month_one': '1mo ago',
      'common.age.month_many': `${params.n}mo ago`,
      'common.age.year_one': '1y ago',
      'common.age.year_many': `${params.n}y ago`,
    };
    return dict[key] || key;
  },
}));

import { relativeAge, resumePdfFilename } from './format.mjs';

describe('relativeAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T12:00:00Z'));
  });

  it('returns just now for less than one hour', () => {
    expect(relativeAge('2026-08-08T11:30:00Z')).toBe('just now');
  });

  it('returns singular hour for one hour', () => {
    expect(relativeAge('2026-08-08T11:00:00Z')).toBe('1 hour ago');
  });

  it('returns plural hours for same-day ages', () => {
    expect(relativeAge('2026-08-08T09:00:00Z')).toBe('3 hours ago');
  });

  it('returns day buckets after 24 hours', () => {
    expect(relativeAge('2026-08-07T11:00:00Z')).toBe('1d ago');
  });

  it('clamps future timestamps to just now', () => {
    expect(relativeAge('2026-08-08T13:00:00Z')).toBe('just now');
  });
});

// Local-time constructor so tests stay deterministic across timezones.
const fixedDate = new Date(2026, 7, 4, 12, 0, 0); // 2026-08-04

describe('resumePdfFilename', () => {
  it('joins name + title + YYMMDD when both are present', () => {
    expect(resumePdfFilename({ name: 'Ada Lovelace', title: 'Stripe - Backend Engineer', date: fixedDate }))
      .toBe('Ada Lovelace - Stripe - Backend Engineer - 260804.pdf');
  });

  it('uses name + CV + YYMMDD when title is absent', () => {
    expect(resumePdfFilename({ name: 'Ada Lovelace', date: fixedDate }))
      .toBe('Ada Lovelace - CV - 260804.pdf');
  });

  it('trims surrounding whitespace on name and title', () => {
    expect(resumePdfFilename({ name: '  Ada Lovelace  ', title: '  Stripe  ', date: fixedDate }))
      .toBe('Ada Lovelace - Stripe - 260804.pdf');
  });

  it('falls back to the fallback + stamp when name is absent', () => {
    expect(resumePdfFilename({ fallback: 'Draft résumé', date: fixedDate }))
      .toBe('Draft résumé - 260804.pdf');
  });

  it('falls back to "resume" + stamp when name, title, and fallback are all empty', () => {
    expect(resumePdfFilename({ date: fixedDate })).toBe('resume - 260804.pdf');
  });

  it('strips filesystem-hostile characters from name and title', () => {
    expect(resumePdfFilename({ name: 'Ada/Lovelace?:*<>|"', title: 'Stripe/Backend?', date: fixedDate }))
      .toBe('AdaLovelace - StripeBackend - 260804.pdf');
  });

  it('leaves unicode intact', () => {
    expect(resumePdfFilename({ name: 'Åsa Björk', date: fixedDate }))
      .toBe('Åsa Björk - CV - 260804.pdf');
  });

  it('rejects all-garbage name and falls through to fallback', () => {
    expect(resumePdfFilename({ name: '///', fallback: 'draft', date: fixedDate }))
      .toBe('draft - 260804.pdf');
  });

  it('defaults date to today when omitted', () => {
    const out = resumePdfFilename({ name: 'X' });
    expect(out).toMatch(/^X - CV - \d{6}\.pdf$/);
  });
});