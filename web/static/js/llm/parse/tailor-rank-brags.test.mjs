import { describe, expect, it } from 'vitest';
import { parse } from './tailor-rank-brags.mjs';

describe('tailor-rank-brags parse', () => {
  it('clamps floats, drops invalid ids, dedupes, and sorts by max(swap, relevance)', () => {
    const raw = JSON.stringify({
      ranked: [
        { brag_id: 3, relevance: 0.2, swap_priority: 0.1, why: 'weak signal' },
        { brag_id: 1, relevance: 1.7, swap_priority: 0.3, why: 'clamped high' },
        { brag_id: '2', relevance: '0.55', swap_priority: '0.9', why: 'string inputs work' },
        { brag_id: 0, relevance: 0.9, why: 'zero id dropped' },
        { brag_id: 3, relevance: 0.4, why: 'dup id dropped' },
        { brag_id: 4, relevance: -0.3, swap_priority: -0.5, why: 'clamped low' },
      ],
    });
    const { ranked } = parse(raw);
    // Sort key = max(swap, relevance): 1→1.0, 2→0.9, 3→0.2, 4→0.
    expect(ranked.map((r) => r.brag_id)).toEqual([1, 2, 3, 4]);
    expect(ranked[0].relevance).toBe(1);
    expect(ranked[0].swap_priority).toBe(0.3);
    expect(ranked[1].relevance).toBeCloseTo(0.55);
    expect(ranked[1].swap_priority).toBe(0.9);
    expect(ranked[3].relevance).toBe(0);
    expect(ranked[3].swap_priority).toBe(0);
  });

  it('sanitizes signal lists (caps at 8, drops empties)', () => {
    const raw = JSON.stringify({
      ranked: [{
        brag_id: 1, relevance: 0.5, swap_priority: 0.5,
        signals_hit: ['a', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
        signals_uncovered_by_base: ['x'],
        why: 'ok',
      }],
    });
    const { ranked } = parse(raw);
    expect(ranked[0].signals_hit).toHaveLength(8);
    expect(ranked[0].signals_uncovered_by_base).toEqual(['x']);
  });

  it('accepts target_entry_index and suggested_replaces; rejects negatives', () => {
    const raw = JSON.stringify({
      ranked: [
        { brag_id: 1, relevance: 0.9, swap_priority: 0.9, target_entry_index: 2, suggested_replaces: { bullet_index: 1 }, why: 'valid' },
        { brag_id: 2, relevance: 0.5, swap_priority: 0.5, target_entry_index: -1, suggested_replaces: { bullet_index: -3 }, why: 'negs stripped' },
      ],
    });
    const { ranked } = parse(raw);
    expect(ranked[0].target_entry_index).toBe(2);
    expect(ranked[0].suggested_replaces).toEqual({ bullet_index: 1 });
    expect(ranked[1].target_entry_index).toBeNull();
    expect(ranked[1].suggested_replaces).toBeNull();
  });

  it('tolerates missing ranked array', () => {
    expect(parse('{}')).toEqual({ ranked: [] });
  });

  it('unwraps markdown-fenced JSON output', () => {
    const raw = '```json\n{"ranked":[{"brag_id":5,"relevance":0.8,"swap_priority":0.4,"why":"solid"}]}\n```';
    const { ranked } = parse(raw);
    expect(ranked[0].brag_id).toBe(5);
    expect(ranked[0].relevance).toBe(0.8);
  });

  it('drops brag_ids not present in the input.brags whitelist', () => {
    const raw = JSON.stringify({
      ranked: [
        { brag_id: 1, relevance: 0.9, swap_priority: 0.9, why: 'in set' },
        { brag_id: 99, relevance: 0.8, swap_priority: 0.8, why: 'not in set' },
      ],
    });
    const { ranked } = parse(raw, { input: { brags: [{ id: 1 }, { id: 2 }] } });
    expect(ranked.map((row) => row.brag_id)).toEqual([1]);
  });
});
