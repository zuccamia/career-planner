import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../db/client.mjs', () => ({
  exec: vi.fn(),
  decodeJSON: (raw, fallback) => {
    if (!raw) return fallback;
    try { return JSON.parse(raw); }
    catch { return fallback; }
  },
}));

vi.mock('../db/schema.mjs', () => ({
  LOOKING_FOR_VALUES: ['open', 'internship', 'new_grad', 'full_time', 'contract'],
  SKILL_LEVELS: ['beginner', 'intermediate', 'advanced', 'expert'],
}));

import { exec } from '../db/client.mjs';
import {
  hydrateSkills, hydrateCareerSparks, hydrateTools, hydrateLocations,
  getOverview, updateOverview,
} from './profile-overview.mjs';

describe('profile overview normalization helpers', () => {
  it('hydrateSkills trims, dedupes case-insensitively, and drops invalid rows', () => {
    expect(hydrateSkills([
      { name: '  Python  ' },
      { name: 'python', years: '5', level: 'expert' },
      { name: ' Go ', years: '3', level: 'advanced' },
      { name: 'Rust', years: '', level: 'legendary' },
      { name: '   ' },
      null,
      { nope: 'x' },
    ])).toEqual([
      { name: 'Python' },
      { name: 'Go', years: 3, level: 'advanced' },
      { name: 'Rust' },
    ]);
  });

  it('hydrateSkills preserves first occurrence metadata for duplicate names', () => {
    expect(hydrateSkills([
      { name: 'TypeScript', years: 4, level: 'advanced' },
      { name: 'typescript', years: 8, level: 'expert' },
      { name: 'Node.js' },
      { name: ' node.js ' },
    ])).toEqual([
      { name: 'TypeScript', years: 4, level: 'advanced' },
      { name: 'Node.js' },
    ]);
  });

  it('hydrateCareerSparks returns normalized spark objects, dedupes case-insensitively, and keeps order', () => {
    expect(hydrateCareerSparks([
      { body: '  high-agency team  ' },
      { id: 2, body: 'Remote-friendly', sort_order: 2 },
      { body: 'remote-friendly' },
      { id: 3, body: 'Meaningful work', sort_order: 1 },
      { body: '   ' },
      null,
      { nope: 'x' },
      { body: 'meaningful work' },
    ])).toEqual([
      { id: null, body: 'high-agency team', sort_order: 1 },
      { id: 2, body: 'Remote-friendly', sort_order: 2 },
      { id: 3, body: 'Meaningful work', sort_order: 1 },
    ]);
  });

  it('hydrateTools trims, dedupes case-insensitively, and keeps order', () => {
    expect(hydrateTools([
      '  Notion  ',
      'notion',
      ' Linear ',
      '   ',
      null,
      { name: 'Slack' },
      'slack',
    ])).toEqual([
      'Notion',
      'Linear',
      'slack',
    ]);
  });

  it('hydrateLocations trims, dedupes case-insensitively, drops non-strings, and preserves order', () => {
    expect(hydrateLocations([
      '  Ho Chi Minh City  ',
      'ho chi minh city',
      'Singapore',
      ' Berlin ',
      '   ',
      null,
      42,
      { city: 'Tokyo' },
      'BERLIN',
    ])).toEqual([
      'Ho Chi Minh City',
      'Singapore',
      'Berlin',
    ]);
  });
});

describe('getOverview', () => {
  beforeEach(() => {
    exec.mockReset();
  });

  it('returns null when the singleton row is missing', async () => {
    exec.mockResolvedValue([]);
    expect(await getOverview()).toBeNull();
  });

  it('decodes each JSON column via the matching hydrator and normalizes looking_for', async () => {
    exec.mockResolvedValue([{
      id: 1,
      name: 'Nova',
      skills_json: JSON.stringify([{ name: 'Go', years: 5, level: 'expert' }]),
      tools_json: JSON.stringify(['  Notion  ', 'notion']),
      locations_json: JSON.stringify(['Berlin', 'berlin']),
      looking_for: 'FULL_TIME', // upper-case → normalized to 'full_time'
    }]);
    const row = await getOverview();
    expect(row.skills).toEqual([{ name: 'Go', years: 5, level: 'expert' }]);
    expect(row.tools).toEqual(['Notion']);
    expect(row.locations).toEqual(['Berlin']);
    expect(row.looking_for).toBe('full_time');
  });

  it('falls back to [] and hydrates gracefully when a JSON column is malformed', async () => {
    exec.mockResolvedValue([{
      id: 1,
      skills_json: '{not-json',
      tools_json: '',
      locations_json: null,
      looking_for: '',
    }]);
    const row = await getOverview();
    expect(row.skills).toEqual([]);
    expect(row.tools).toEqual([]);
    expect(row.locations).toEqual([]);
    // Empty looking_for falls back to 'open' per hydrateLookingFor.
    expect(row.looking_for).toBe('open');
  });
});

describe('updateOverview', () => {
  beforeEach(() => {
    exec.mockReset();
    exec.mockResolvedValue([]);
  });

  const capturedWrite = () => {
    // Second-to-last mock call is the UPDATE (last one may be internal noise);
    // pick the first call whose SQL starts with UPDATE.
    for (const call of exec.mock.calls) {
      if (String(call[0]).trim().startsWith('UPDATE')) return call;
    }
    return null;
  };

  it('is a no-op when the patch has no editable columns', async () => {
    await updateOverview({ irrelevant: 'x' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('JSON-encodes skills into skills_json only and leaves other JSON cols alone', async () => {
    await updateOverview({ skills: [{ name: '  Go  ', years: 3 }, { name: 'go' }] });
    const [sql, values] = capturedWrite();
    expect(sql).toMatch(/SET\s+skills_json = \?/);
    // Only skills_json + updated_at in the SET clause.
    expect(sql).not.toMatch(/tools_json/);
    expect(sql).not.toMatch(/locations_json/);
    // Value is the JSON-encoded hydrated array (trimmed + deduped).
    expect(JSON.parse(values[0])).toEqual([{ name: 'Go', years: 3 }]);
  });

  it('routes tools + locations through their hydrators into the matching JSON cols', async () => {
    await updateOverview({
      tools: ['  Notion  ', 'notion'],
      locations: ['Berlin', 'berlin'],
    });
    const [sql, values] = capturedWrite();
    expect(sql).toMatch(/tools_json = \?/);
    expect(sql).toMatch(/locations_json = \?/);
    expect(sql).not.toMatch(/skills_json/);
    // The two values are hydrated + stringified. Order matches SET clause.
    const parsed = values.slice(0, 2).map(v => JSON.parse(v));
    expect(parsed).toContainEqual(['Notion']);
    expect(parsed).toContainEqual(['Berlin']);
  });

  it('normalizes looking_for on write', async () => {
    await updateOverview({ looking_for: '  FULL_TIME  ' });
    const [sql, values] = capturedWrite();
    expect(sql).toMatch(/looking_for = \?/);
    expect(values[0]).toBe('full_time');
  });

  it('always stamps updated_at and scopes WHERE id = 1', async () => {
    await updateOverview({ name: 'Nova' });
    const [sql, values] = capturedWrite();
    expect(sql).toMatch(/updated_at = datetime\('now'\)/);
    expect(sql).toMatch(/WHERE id = 1/);
    expect(values[0]).toBe('Nova');
  });
});