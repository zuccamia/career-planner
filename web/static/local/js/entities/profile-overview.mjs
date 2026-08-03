// Career profile overview — singleton row (id=1) seeded by migration 004.
// One "about me" block per browser DB (multi-profile is a future concern).

import { exec } from '../db/client.mjs';

const EDITABLE_COLS = ['name', 'headline', 'summary', 'skills_json', 'environment', 'tools_json'];

// Levels the UI dropdown offers. Kept as a sorted list so ordering in the
// select matches ascending expertise. Exposed so callers (form + wizard)
// share one source of truth.
export const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'];

// hydrateSkills accepts whatever came out of skills_json (string array or
// object array — legacy rows use bare strings) and returns a normalized
// array of {name, years?, level?} objects. Unknown levels are dropped so
// stale/invalid values don't stick around forever.
const hydrateSkills = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (typeof item === 'string') return { name: item };
      if (item && typeof item === 'object' && typeof item.name === 'string') {
        const out = { name: item.name };
        if (item.years != null && item.years !== '') out.years = Number(item.years);
        if (item.level && SKILL_LEVELS.includes(item.level)) out.level = item.level;
        return out;
      }
      return null;
    })
    .filter(s => s && s.name.trim());
};

const hydrateTools = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
};

export const getOverview = async () => {
  const rows = await exec('SELECT * FROM profile_overview WHERE id = 1');
  const row = rows[0];
  if (!row) return null;
  // Decode skills_json → skills array of {name, years?, level?} so callers
  // work with structured objects. Legacy string-shaped rows coerce cleanly.
  let parsedSkills = [];
  try { parsedSkills = JSON.parse(row.skills_json || '[]'); }
  catch { parsedSkills = []; }
  row.skills = hydrateSkills(parsedSkills);
  let parsedTools = [];
  try { parsedTools = JSON.parse(row.tools_json || '[]'); }
  catch { parsedTools = []; }
  row.tools = hydrateTools(parsedTools);
  return row;
};

// updateOverview accepts a partial patch. Only fields present in `data` (and
// in EDITABLE_COLS) are written. The flat form on the Profile page uses this
// to save one field at a time when its input blurs, without touching the
// others. (The wizard also calls this, but commits on Next/Skip rather than
// blur — same partial-patch semantics either way.)
//
// Callers can pass `skills` as an array of {name, years?, level?} objects
// (or bare strings for backward compat with the earlier shape). Normalized
// via hydrateSkills before persistence so junk (empty names, bogus levels)
// doesn't survive the round-trip. `tools` accepts an array of strings.
export const updateOverview = async (data) => {
  const patch = { ...data };
  if (Object.prototype.hasOwnProperty.call(patch, 'skills')) {
    patch.skills_json = JSON.stringify(hydrateSkills(patch.skills));
    delete patch.skills;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'tools')) {
    patch.tools_json = JSON.stringify(hydrateTools(patch.tools));
    delete patch.tools;
  }
  const cols = EDITABLE_COLS.filter(c => Object.prototype.hasOwnProperty.call(patch, c));
  if (!cols.length) return;
  const values = cols.map(c => (patch[c] ?? '').toString());
  await exec(
    `UPDATE profile_overview
     SET ${cols.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = 1`,
    values,
  );
};

export const markOnboarded = () =>
  exec(`UPDATE profile_overview SET onboarded_at = datetime('now'), updated_at = datetime('now') WHERE id = 1`);

export const clearOnboarded = () =>
  exec(`UPDATE profile_overview SET onboarded_at = NULL, updated_at = datetime('now') WHERE id = 1`);

export const getWizardProgress = async () => {
  const rows = await exec('SELECT wizard_progress FROM profile_overview WHERE id = 1');
  const raw = rows[0]?.wizard_progress;
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
};

export const setWizardProgress = (obj) =>
  exec(
    `UPDATE profile_overview SET wizard_progress = ?, updated_at = datetime('now') WHERE id = 1`,
    [JSON.stringify(obj)],
  );

export const clearWizardProgress = () =>
  exec(`UPDATE profile_overview SET wizard_progress = NULL, updated_at = datetime('now') WHERE id = 1`);
