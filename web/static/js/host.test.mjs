import { afterEach, describe, expect, it } from 'vitest';
import { isStaticHost, urlFor, STATIC_ROOT, _resetStaticHostForTests } from './host.mjs';

const setMeta = (value) => {
  document.head.querySelectorAll('meta[name=static-host]').forEach((n) => n.remove());
  if (value !== null) {
    const m = document.createElement('meta');
    m.setAttribute('name', 'static-host');
    m.setAttribute('content', value);
    document.head.appendChild(m);
  }
  _resetStaticHostForTests();
};

afterEach(() => setMeta(null));

describe('isStaticHost', () => {
  it('returns false when the meta tag is absent', () => {
    setMeta(null);
    expect(isStaticHost()).toBe(false);
  });

  it('returns true when the meta tag says true', () => {
    setMeta('true');
    expect(isStaticHost()).toBe(true);
  });

  it('returns false when the meta tag says false', () => {
    setMeta('false');
    expect(isStaticHost()).toBe(false);
  });

  it('returns false for any other value', () => {
    setMeta('yes');
    expect(isStaticHost()).toBe(false);
    setMeta('');
    _resetStaticHostForTests();
    expect(isStaticHost()).toBe(false);
  });

  it('memoizes the DOM read across calls', () => {
    setMeta('true');
    expect(isStaticHost()).toBe(true);
    // Mutate the DOM *without* clearing the memo — cached value must stick.
    document.head.querySelectorAll('meta[name=static-host]').forEach((n) => n.remove());
    expect(isStaticHost()).toBe(true);
  });
});

describe('STATIC_ROOT', () => {
  it('ends with a slash — regression against template-literal concat bugs', () => {
    // Without a trailing slash, `${STATIC_ROOT}i18n/manifest.json` becomes
    // "static/i18n/..." → "statici18n/..." — a real production bug we hit
    // when happy-dom (or any WHATWG runtime that drops the trailing slash)
    // resolved `new URL('..', import.meta.url).href` without it.
    expect(STATIC_ROOT.endsWith('/')).toBe(true);
  });

  it('points at the static/ directory (not something under it)', () => {
    expect(STATIC_ROOT).toMatch(/\/static\/$/);
  });
});

describe('urlFor', () => {
  it('returns page unchanged on hosted', () => {
    setMeta('false');
    expect(urlFor('dashboard')).toBe('dashboard');
    expect(urlFor('companies?new=1')).toBe('companies?new=1');
    expect(urlFor('settings#ai-provider')).toBe('settings#ai-provider');
  });

  it('appends .html on static, preserving query/hash', () => {
    setMeta('true');
    expect(urlFor('dashboard')).toBe('dashboard.html');
    expect(urlFor('companies?new=1')).toBe('companies.html?new=1');
    expect(urlFor('settings#ai-provider')).toBe('settings.html#ai-provider');
  });
});
