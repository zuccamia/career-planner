import { describe, expect, it } from 'vitest';
import {
  cacheKey, getCachedExtraction, setCachedExtraction,
  filterDuplicatesAgainst, findClosestExisting,
  SIMILARITY_HINT_THRESHOLD,
  chunkMarkdownBySections, chunkSnippet, MD_CHUNK_THRESHOLD_CHARS,
  mapWithConcurrency, isRateLimitError, retryOnRateLimit,
} from './profile-import-helpers.mjs';

// ------------------- cache -------------------

describe('extraction cache', () => {
  it('cacheKey combines locale and hash', () => {
    const k1 = cacheKey('# CV', 'en');
    const k2 = cacheKey('# CV', 'vi');
    const k3 = cacheKey('# Other CV', 'en');
    expect(k1).toMatch(/^en:/);
    expect(k2).toMatch(/^vi:/);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('same input returns the cached value', () => {
    setCachedExtraction('hello world', 'en', ['a', 'b']);
    expect(getCachedExtraction('hello world', 'en')).toEqual(['a', 'b']);
  });

  it('different locale misses the cache', () => {
    setCachedExtraction('only-en', 'en', [1]);
    expect(getCachedExtraction('only-en', 'vi')).toBeUndefined();
  });

  it('different markdown misses the cache', () => {
    setCachedExtraction('one', 'en', [1]);
    expect(getCachedExtraction('two', 'en')).toBeUndefined();
  });
});

// ------------------- filterDuplicatesAgainst -------------------

describe('filterDuplicatesAgainst', () => {
  it('keeps candidates that don\'t match any existing', () => {
    const existing = [{ title: 'Shipped X', body: 'Rolled out feature X' }];
    const candidates = [{ title: 'Improved Y', body: 'Refactored Y module' }];
    const { keep, skipped } = filterDuplicatesAgainst(candidates, existing);
    expect(keep).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('skips candidates whose (title, body) matches an existing brag', () => {
    const existing = [{ title: 'Cut latency', body: 'Rewrote query planner.' }];
    const candidates = [{ title: 'Cut latency', body: 'Rewrote query planner.' }];
    const { keep, skipped } = filterDuplicatesAgainst(candidates, existing);
    expect(keep).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('duplicate');
    expect(skipped[0].match).toEqual(existing[0]);
  });

  it('normalizes case, punctuation, and whitespace before comparing', () => {
    const existing = [{ title: 'Cut Latency!', body: 'Rewrote query planner.' }];
    const candidates = [{ title: 'cut  latency', body: 'rewrote query planner' }];
    const { keep } = filterDuplicatesAgainst(candidates, existing);
    expect(keep).toHaveLength(0);
  });

  it('collapses duplicates within the same batch', () => {
    const candidates = [
      { title: 'Cut latency', body: 'Rewrote query planner' },
      { title: 'cut latency', body: 'rewrote query planner' },
    ];
    const { keep, skipped } = filterDuplicatesAgainst(candidates, []);
    expect(keep).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('duplicate_in_batch');
  });

  it('tolerates missing existing/candidate fields', () => {
    const { keep, skipped } = filterDuplicatesAgainst([{ title: '' }, {}], []);
    // Both fingerprint to the empty string → the second is a batch-dup.
    expect(keep).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });
});

// ------------------- findClosestExisting -------------------

describe('findClosestExisting', () => {
  it('returns null match when nothing exceeds the threshold', () => {
    const candidate = { title: 'Foo bar', body: 'baz qux' };
    const existing = [{ title: 'Completely different', body: 'other content' }];
    const { match, score } = findClosestExisting(candidate, existing);
    expect(match).toBeNull();
    expect(score).toBeLessThan(SIMILARITY_HINT_THRESHOLD);
  });

  it('flags near-duplicates that share vocabulary', () => {
    const candidate = {
      title: 'Elasticsearch payment search sub-second latency',
      body: 'Rewrote payment search on Elasticsearch',
    };
    const existing = [{
      title: 'Elasticsearch payment search indexing sub-second',
      body: 'Introduced Elasticsearch payment search pipeline',
    }];
    const { match, score } = findClosestExisting(candidate, existing);
    expect(match).toBe(existing[0]);
    expect(score).toBeGreaterThan(SIMILARITY_HINT_THRESHOLD);
  });

  it('does not flag paraphrases with disjoint vocabulary', () => {
    // Same achievement in different words — Jaccard on shared tokens is low,
    // so the hint stays quiet. Documented behavior: this heuristic is meant
    // to catch obvious lexical overlap, not semantic similarity.
    const candidate = {
      title: 'Reduced payment search latency from 7s to sub-second',
      body: '',
    };
    const existing = [{
      title: 'Built Elasticsearch indexing pipeline for flash-sale traffic',
      body: '',
    }];
    const { match } = findClosestExisting(candidate, existing);
    expect(match).toBeNull();
  });

  it('picks the highest-scoring existing brag when multiple match', () => {
    const candidate = { title: 'Cut incident detection time', body: 'wrote dashboard' };
    const existing = [
      { title: 'Fixed onboarding', body: 'unrelated work' },
      { title: 'Cut incident detection', body: 'built dashboard' },
    ];
    const { match } = findClosestExisting(candidate, existing);
    expect(match).toBe(existing[1]);
  });

  it('handles empty inputs safely', () => {
    expect(findClosestExisting({}, [])).toEqual({ match: null, score: 0 });
    expect(findClosestExisting({ title: 'x' }, null).match).toBeNull();
  });

  it('drops common stopwords from the token set', () => {
    // The stopwords list means "the and of" alone shouldn't produce a match.
    const candidate = { title: 'the of and', body: '' };
    const existing = [{ title: 'the of and', body: '' }];
    const { match, score } = findClosestExisting(candidate, existing);
    expect(match).toBeNull();
    expect(score).toBe(0);
  });
});

// ------------------- chunkMarkdownBySections -------------------

describe('chunkMarkdownBySections', () => {
  const fill = (n) => 'x'.repeat(n);

  it('returns [] for empty input', () => {
    expect(chunkMarkdownBySections('')).toEqual([]);
    expect(chunkMarkdownBySections('   \n\n  ')).toEqual([]);
    expect(chunkMarkdownBySections(null)).toEqual([]);
  });

  it('returns the input as a single chunk when under the threshold', () => {
    const md = '# Title\n\nSome short body.';
    expect(chunkMarkdownBySections(md)).toEqual([md]);
  });

  it('exposes the threshold constant', () => {
    expect(MD_CHUNK_THRESHOLD_CHARS).toBeGreaterThan(0);
  });

  it('splits at top-level # headings when over the threshold', () => {
    const md = [
      `# Section A\n${fill(60)}`,
      `# Section B\n${fill(60)}`,
      `# Section C\n${fill(60)}`,
    ].join('\n');
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatch(/^# Section A/);
    expect(chunks[1]).toMatch(/^# Section B/);
    expect(chunks[2]).toMatch(/^# Section C/);
  });

  it('preserves preamble before the first heading', () => {
    const md = `Contact: me@example.com\n\n# Experience\n${fill(60)}\n# Skills\n${fill(60)}`;
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    expect(chunks[0]).toMatch(/Contact: me@example.com/);
    expect(chunks.some((c) => /^# Experience/.test(c))).toBe(true);
    expect(chunks.some((c) => /^# Skills/.test(c))).toBe(true);
  });

  it('falls back to ## when a top-level section is still too large', () => {
    const md = `# Experience\n## Role A\n${fill(60)}\n## Role B\n${fill(60)}`;
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    // Each ## sibling gets its own chunk, prefixed with the # ancestor.
    expect(chunks.some((c) => /## Role A/.test(c))).toBe(true);
    expect(chunks.some((c) => /## Role B/.test(c))).toBe(true);
  });

  it('falls back to ### when a ## section is still too large', () => {
    const md = `# Experience\n## Roles\n### Role A\n${fill(60)}\n### Role B\n${fill(60)}`;
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    expect(chunks.some((c) => /### Role A/.test(c))).toBe(true);
    expect(chunks.some((c) => /### Role B/.test(c))).toBe(true);
  });

  it('prepends ancestor headings so sub-sections carry parent context', () => {
    const md = `# Experience\n## Role A\n### Impl X\n${fill(60)}\n### Impl Y\n${fill(60)}`;
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    // Every chunk that surfaces a ### Impl heading should also carry the
    // enclosing ## Role A label as breadcrumb context.
    for (const c of chunks) {
      if (/### Impl [XY]/.test(c)) expect(c).toMatch(/## Role A/);
    }
  });

  it('coalesces a numbered run into a single chunk so ranking survives', () => {
    const items = Array.from({ length: 12 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
    const md = `## Priorities\n${items}`;
    // maxChars smaller than the run — heading levels give up, so we hit the
    // item-level fallback. The numbered run should still emit as one chunk
    // because order carries meaning.
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    const numberedChunks = chunks.filter((c) => /1\. Item 1/.test(c));
    expect(numberedChunks).toHaveLength(1);
    expect(numberedChunks[0]).toMatch(/12\. Item 12/);
  });

  it('returns the original section when no sub-headings exist to split on', () => {
    // Over threshold, no ## or ### — falls through and emits the section as-is.
    const md = `# Experience\n${fill(200)}`;
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^# Experience/);
  });

  it('does not treat ## lines as top-level # boundaries', () => {
    // Under threshold: no split, returned verbatim. The point is that `## `
    // shouldn't match the `# ` regex — if it did, this short input would still
    // be returned as a single chunk anyway, but oversized cases (see the ##
    // fallback test above) prove the discriminator is real.
    const md = `## Sub A\n${fill(20)}\n## Sub B\n${fill(20)}`;
    const chunks = chunkMarkdownBySections(md, { maxChars: 200 });
    expect(chunks).toEqual([md.trim()]);
  });

  it('never returns empty chunks', () => {
    const md = `# A\n${fill(60)}\n\n\n# B\n${fill(60)}`;
    const chunks = chunkMarkdownBySections(md, { maxChars: 80 });
    for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
  });
});

// ------------------- mapWithConcurrency -------------------

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const worker = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, worker);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

// ------------------- isRateLimitError -------------------

describe('isRateLimitError', () => {
  it('matches common rate-limit phrases', () => {
    expect(isRateLimitError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('quota exceeded for this key'))).toBe(true);
    expect(isRateLimitError({ message: 'rate_limit_reached' })).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isRateLimitError(new Error('connection refused'))).toBe(false);
    expect(isRateLimitError(new Error('invalid_json'))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

// ------------------- retryOnRateLimit -------------------

describe('retryOnRateLimit', () => {
  it('returns the value on first success', async () => {
    const r = await retryOnRateLimit(async () => 'ok', { delayMs: 1 });
    expect(r).toBe('ok');
  });

  it('retries once on a rate-limit error, then succeeds', async () => {
    let calls = 0;
    const r = await retryOnRateLimit(async () => {
      calls++;
      if (calls === 1) throw new Error('rate limit exceeded');
      return 'ok';
    }, { delayMs: 1 });
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  it('rethrows if the second attempt also rate-limits', async () => {
    let calls = 0;
    await expect(
      retryOnRateLimit(async () => {
        calls++;
        throw new Error('rate limit exceeded');
      }, { delayMs: 1 }),
    ).rejects.toThrow(/rate limit/);
    expect(calls).toBe(2);
  });

  it('does not retry on non-rate-limit errors', async () => {
    let calls = 0;
    await expect(
      retryOnRateLimit(async () => {
        calls++;
        throw new Error('bad request');
      }, { delayMs: 1 }),
    ).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });
});

// ------------------- chunkSnippet -------------------

describe('chunkSnippet', () => {
  it('picks the deepest heading over the breadcrumb ancestor', () => {
    // Breadcrumb-prepended chunk: outer `# Experience` followed by the
    // local `### Refactored X`. The local one is the identifier we want.
    const chunk = '# Experience\n\n## Role A\n\n### Refactored X\n\nbody line';
    expect(chunkSnippet(chunk)).toBe('### Refactored X');
  });

  it('falls back to the first body line when no heading is present', () => {
    // Item-level chunk under an ancestor breadcrumb — the local content is
    // a bullet with no local heading.
    const chunk = '## 2024 wins\n\n- Rebuilt payment pipeline in three weeks';
    // The ancestor "## 2024 wins" IS a heading here; it should be picked.
    expect(chunkSnippet(chunk)).toBe('## 2024 wins');
  });

  it('picks first body line when there is no heading at all', () => {
    const chunk = '- Rebuilt payment pipeline\n- Cut latency 40%';
    expect(chunkSnippet(chunk)).toBe('- Rebuilt payment pipeline');
  });

  it('truncates with an ellipsis past maxLen', () => {
    const chunk = '### ' + 'x'.repeat(200);
    const out = chunkSnippet(chunk, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty and whitespace input', () => {
    expect(chunkSnippet('')).toBe('');
    expect(chunkSnippet('   \n\n  ')).toBe('');
    expect(chunkSnippet(null)).toBe('');
  });
});
