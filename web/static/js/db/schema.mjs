// Browser-side schema bootstrap. Fetches the ordered migration filenames
// from /static/db/migrations/manifest.json, downloads each SQL file, and
// applies any not-yet-run migration against the OPFS-backed SQLite,
// tracking progress via PRAGMA user_version. Enum constants come from
// /static/db/enums.json.
//
// Offline resilience: after the first successful fetch we cache both
// payloads in IndexedDB. On subsequent boots we prefer the network but
// fall back to the cached copy if the fetch fails. First-ever boot still
// requires network.

import { exec } from './client.mjs';
import { idbGet, idbSet } from '../storage/idb.mjs';
import { STATIC_ROOT } from '../host.mjs';

const MIGRATIONS_MANIFEST_URL = `${STATIC_ROOT}db/migrations/manifest.json`;
const MIGRATIONS_DIR = `${STATIC_ROOT}db/migrations/`;
const ENUMS_URL = `${STATIC_ROOT}db/enums.json`;
const CACHE_MIGRATIONS_KEY = 'schemaMigrationsCache';
const CACHE_ENUMS_KEY = 'schemaEnumsCache';

// Mirrors the enums in web/static/db/enums.json. Start empty because ES
// modules can't await at import time; ensureSchema populates them during
// boot. Read after ensureSchema resolves.
export let APPLICATION_STATUSES = [];
export let COMMUNICATION_CHANNELS = [];
export let COMMUNICATION_DIRECTIONS = [];
export let COMMUNICATION_STATUSES = [];
export let LOOKING_FOR_VALUES = [];
export let SKILL_LEVELS = [];

const MIGRATION_FILE_RE = /^(\d+)_([^./]+)\.sql$/;

const fetchJSONWithCache = async (url, cacheKey) => {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    await idbSet(cacheKey, text);
    return { value: JSON.parse(text), source: 'network' };
  } catch (err) {
    const cached = await idbGet(cacheKey);
    if (cached == null) throw new Error(`fetch ${url} failed and no cached copy: ${err.message}`);
    console.warn(`[schema] using cached ${cacheKey} — ${err.message}`);
    return { value: JSON.parse(cached), source: 'cache' };
  }
};

// fetchMigrations resolves to an array of {version, name, sql} rows. Fetches
// the manifest, then the SQL files in parallel (browsers cap parallel fetches
// per-origin, which naturally rate-limits us). The cache key stores the
// assembled array, not the manifest, so a partial fetch failure falls back
// to the last known-good full set.
const fetchMigrations = async () => {
  try {
    const manifestRes = await fetch(MIGRATIONS_MANIFEST_URL, { cache: 'no-cache' });
    if (!manifestRes.ok) throw new Error(`manifest HTTP ${manifestRes.status}`);
    const filenames = await manifestRes.json();
    const rows = await Promise.all(filenames.map(async (name) => {
      const match = MIGRATION_FILE_RE.exec(name);
      if (!match) throw new Error(`manifest entry ${name} does not match NNN_name.sql`);
      const [, versionStr, migName] = match;
      const sqlRes = await fetch(MIGRATIONS_DIR + name, { cache: 'no-cache' });
      if (!sqlRes.ok) throw new Error(`${name} HTTP ${sqlRes.status}`);
      return { version: Number(versionStr), name: migName, sql: await sqlRes.text() };
    }));
    await idbSet(CACHE_MIGRATIONS_KEY, JSON.stringify(rows));
    return { value: rows, source: 'network' };
  } catch (err) {
    const cached = await idbGet(CACHE_MIGRATIONS_KEY);
    if (cached == null) throw new Error(`fetch migrations failed and no cached copy: ${err.message}`);
    console.warn(`[schema] using cached migrations — ${err.message}`);
    return { value: JSON.parse(cached), source: 'cache' };
  }
};

const readUserVersion = async () => {
  const rows = await exec('PRAGMA user_version');
  const row = rows && rows[0];
  if (!row) return 0;
  // sqlite-wasm returns the pragma value under the pragma name; guard for
  // shape differences across versions.
  return Number(row.user_version ?? row.PRAGMA ?? Object.values(row)[0] ?? 0);
};

// "Duplicate column" is treated as a no-op so ADD COLUMN migrations succeed
// against DBs that already had the column (e.g. installs seeded from a
// snapshot that predates versioned migrations). Mirrors the seed migrate loop.
const isBenignMigrationError = (err) => {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  return msg.includes('duplicate column');
};

export const ensureSchema = async () => {
  const { value: migrations, source: migrationsSource } = await fetchMigrations();
  const { value: enums, source: enumsSource } = await fetchJSONWithCache(
    ENUMS_URL, CACHE_ENUMS_KEY,
  );

  APPLICATION_STATUSES = enums.application_statuses || [];
  COMMUNICATION_CHANNELS = enums.communication_channels || [];
  COMMUNICATION_DIRECTIONS = enums.communication_directions || [];
  COMMUNICATION_STATUSES = enums.communication_statuses || [];
  LOOKING_FOR_VALUES = enums.looking_for_values || [];
  SKILL_LEVELS = enums.skill_levels || [];

  await exec('PRAGMA foreign_keys = ON');

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const current = await readUserVersion();
  const applied = [];
  for (const m of ordered) {
    if (m.version <= current) continue;
    try {
      await exec(m.sql);
    } catch (err) {
      if (!isBenignMigrationError(err)) throw err;
    }
    // PRAGMA user_version does not accept a bind parameter, so interpolate.
    // m.version is a Number cast from the manifest — no untrusted input.
    await exec(`PRAGMA user_version = ${Number(m.version)}`);
    applied.push(m.version);
  }

  const latest = ordered.length ? ordered[ordered.length - 1].version : current;
  console.log(`[schema] ready at v${latest} (migrations=${migrationsSource}, enums=${enumsSource}, applied=[${applied.join(',')}])`);
};
