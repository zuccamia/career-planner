import { describe, expect, it } from 'vitest';
import { quoteGo, sprintf } from './sprintf.mjs';

describe('quoteGo', () => {
  it('quotes plain ASCII', () => {
    expect(quoteGo('hello')).toBe('"hello"');
  });
  it('escapes backslash, double quote, and standard C escapes', () => {
    expect(quoteGo('a\\b')).toBe('"a\\\\b"');
    expect(quoteGo('a"b')).toBe('"a\\"b"');
    expect(quoteGo('a\nb')).toBe('"a\\nb"');
    expect(quoteGo('a\tb')).toBe('"a\\tb"');
    expect(quoteGo('a\rb')).toBe('"a\\rb"');
  });
  it('escapes non-tab/newline C0 controls with \\x hex', () => {
    expect(quoteGo('a\x01b')).toBe('"a\\x01b"');
    expect(quoteGo('\x00')).toBe('"\\x00"');
  });
  it('passes non-ASCII through verbatim (documented divergence from Go)', () => {
    expect(quoteGo('café')).toBe('"café"');
    expect(quoteGo('résumé')).toBe('"résumé"');
    expect(quoteGo('CV tiếng Việt')).toBe('"CV tiếng Việt"');
  });
  it('handles null/undefined as empty', () => {
    expect(quoteGo(null)).toBe('""');
    expect(quoteGo(undefined)).toBe('""');
  });
});

describe('sprintf', () => {
  it('returns empty template unchanged', () => {
    expect(sprintf('')).toBe('');
  });
  it('returns template with no verbs unchanged', () => {
    expect(sprintf('hello world')).toBe('hello world');
  });
  it('substitutes a single %s', () => {
    expect(sprintf('hi %s!', 'ada')).toBe('hi ada!');
  });
  it('substitutes a single %q with proper quoting', () => {
    expect(sprintf('name=%q', 'ada')).toBe('name="ada"');
  });
  it('substitutes several verbs positionally', () => {
    expect(sprintf('%s / %q / %s', 'a', 'b', 'c')).toBe('a / "b" / c');
  });
  it('honours the %% literal escape', () => {
    expect(sprintf('100%% of %s', 'us')).toBe('100% of us');
  });
  it('renders null/undefined args as empty (not "undefined")', () => {
    expect(sprintf('%s', undefined)).toBe('');
    expect(sprintf('%s', null)).toBe('');
    expect(sprintf('%q', undefined)).toBe('""');
    expect(sprintf('%q', null)).toBe('""');
  });

  // Regression: every failure mode we want to catch at test time.
  it('throws when template has more slots than args', () => {
    expect(() => sprintf('%s %s', 'only-one')).toThrowError(/expects at least 2 args, got 1/);
  });
  it('throws when args exceed slots', () => {
    expect(() => sprintf('%s', 'a', 'b')).toThrowError(/uses 1 args, got 2/);
  });
  it('throws on an unknown verb', () => {
    expect(() => sprintf('%d', 5)).toThrowError(/unsupported verb %d/);
    expect(() => sprintf('%v', 5)).toThrowError(/unsupported verb %v/);
  });
  it('throws on a lone trailing %', () => {
    expect(() => sprintf('hello %')).toThrowError(/lone '%' at end of template/);
  });
  it('handles zero args and zero verbs together', () => {
    expect(sprintf('nothing')).toBe('nothing');
  });
});
