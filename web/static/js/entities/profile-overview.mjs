// Career profile overview — singleton row (id=1) seeded by migration 004.
// One "about me" block per browser DB (multi-profile is a future concern).

import { exec, decodeJSON } from '../db/client.mjs';
import { LOOKING_FOR_VALUES, SKILL_LEVELS } from '../db/schema.mjs';

const EDITABLE_COLS = ['name', 'headline', 'summary', 'skills_json', 'workplace_type', 'tools_json', 'looking_for', 'locations_json'];

// hydrateSkills accepts object rows from skills_json and returns a normalized
// array of {name, years?, level?} objects. Unknown levels are dropped so
// stale/invalid values don't stick around forever.
export const hydrateSkills = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') continue;
    const skill = { name: item.name };
    if (item.years != null && item.years !== '') skill.years = Number(item.years);
    if (item.level && SKILL_LEVELS.includes(item.level)) skill.level = item.level;
    skill.name = skill.name.trim();
    if (!skill.name) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out;
};

// hydrateCareerSparks accepts spark-like objects and returns a trimmed ordered
// list of normalized spark objects with case-insensitive dedupe by body.
// Existing metadata (id, sort_order, etc.) is preserved from the first
// occurrence.
export const hydrateCareerSparks = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.body !== 'string') continue;
    const spark = { ...item, id: item.id ?? null, sort_order: item.sort_order ?? 1, body: item.body };
    spark.body = spark.body.trim();
    if (!spark.body) continue;
    const key = spark.body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spark);
  }
  return out;
};

export const hydrateTools = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    let tool = null;
    if (typeof item === 'string') tool = item.trim();
    if (!tool) continue;
    const key = tool.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tool);
  }
  return out;
};

// hydrateLocations returns a deduped array of trimmed non-empty strings.
// Order is preserved so the user's priority ("home base first") survives
// the round-trip.
export const hydrateLocations = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
};

// Normalize a looking_for value to one of LOOKING_FOR_VALUES. Unknown or
// missing values fall back to 'open' so a stale row can't leak into prompts
// with a garbage employment type.
const hydrateLookingFor = (raw) => {
  const v = (raw || '').toString().trim().toLowerCase();
  return LOOKING_FOR_VALUES.includes(v) ? v : 'open';
};

// Map from the caller-facing patch key to the persisted TEXT-JSON column +
// hydrator. Drives both the decode side of getOverview and the encode side of
// updateOverview, so a new JSON field only needs one entry here.
const JSON_COLS = {
  skills:    ['skills_json',    hydrateSkills],
  tools:     ['tools_json',     hydrateTools],
  locations: ['locations_json', hydrateLocations],
};

export const getOverview = async () => {
  const rows = await exec('SELECT * FROM profile_overview WHERE id = 1');
  const row = rows[0];
  if (!row) return null;
  for (const [key, [col, hydrator]] of Object.entries(JSON_COLS)) {
    row[key] = hydrator(decodeJSON(row[col], []));
  }
  row.looking_for = hydrateLookingFor(row.looking_for);
  return row;
};

// updateOverview accepts a partial patch. Only fields present in `data` (and
// in EDITABLE_COLS) are written. The flat form on the Profile page uses this
// to save one field at a time when its input blurs, without touching the
// others. (The wizard also calls this, but commits on Next/Skip rather than
// blur — same partial-patch semantics either way.)
//
// Callers can pass `skills`, `tools`, or `locations` as arrays; each is
// hydrated + JSON-encoded into its TEXT column before persistence so junk
// (empty names, bogus levels, dupes) doesn't survive the round-trip.
export const updateOverview = async (data) => {
  const patch = { ...data };
  for (const [key, [col, hydrator]] of Object.entries(JSON_COLS)) {
    if (Object.hasOwn(patch, key)) {
      patch[col] = JSON.stringify(hydrator(patch[key]));
      delete patch[key];
    }
  }
  if (Object.hasOwn(patch, 'looking_for')) {
    patch.looking_for = hydrateLookingFor(patch.looking_for);
  }
  const cols = EDITABLE_COLS.filter(c => Object.hasOwn(patch, c));
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
