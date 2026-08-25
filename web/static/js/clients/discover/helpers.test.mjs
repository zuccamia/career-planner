// Tests for helpers.mjs — currently gone-cache; extend as needed.

import { describe, it, expect } from 'vitest';
import { makeGoneCache } from './helpers.mjs';

describe('gone-cache', () => {
  it('add + has round-trip', () => {
    const c = makeGoneCache();
    c.add('https://x.com/1');
    expect(c.has('https://x.com/1')).toBe(true);
    expect(c.has('https://x.com/2')).toBe(false);
  });

  it('add is idempotent (double-add does not consume two slots)', () => {
    const c = makeGoneCache();
    // Fill just up to cap with one duplicated entry. If add double-counted,
    // the 257th insert would trigger eviction and drop 'sentinel'.
    c.add('https://x.com/sentinel');
    c.add('https://x.com/sentinel');
    for (let i = 0; i < 254; i++) c.add(`https://x.com/${i}`);
    expect(c.has('https://x.com/sentinel')).toBe(true);
  });

  it('empty and whitespace input is ignored', () => {
    const c = makeGoneCache();
    c.add('');
    c.add('   ');
    c.add(null);
    c.add(undefined);
    expect(c.has('')).toBe(false);
  });

  it('trims input consistently on add and has', () => {
    const c = makeGoneCache();
    c.add('  https://x.com/1  ');
    expect(c.has('https://x.com/1')).toBe(true);
    expect(c.has('  https://x.com/1  ')).toBe(true);
  });

  it('evicts oldest half when cap is exceeded', () => {
    const c = makeGoneCache();
    // Cap is 256 internally. Insert 260 → first eviction fires when
    // adding the 257th, dropping ~128 oldest.
    for (let i = 0; i < 260; i++) c.add(`https://x.com/${i}`);
    // Oldest entries should be gone; newest should stay.
    expect(c.has('https://x.com/0')).toBe(false);
    expect(c.has('https://x.com/259')).toBe(true);
  });

  it('makeGoneCache returns isolated instances', () => {
    const a = makeGoneCache();
    const b = makeGoneCache();
    a.add('https://x.com/1');
    expect(b.has('https://x.com/1')).toBe(false);
  });
});
