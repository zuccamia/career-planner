// Browser-side schema bootstrap. Fetches the ordered migration list from the
// Go server and applies any not-yet-run migration against the OPFS-backed
// SQLite, tracking progress via PRAGMA user_version. Enum constants come from
// /api/db/enums.json — same file the Go handlers use.
//
// Offline resilience: after the first successful fetch we cache both payloads
// in IndexedDB. On subsequent boots we prefer the network but fall back to
// the cached copy if the fetch fails. First-ever boot still requires network.

import { exec } from './client.mjs';
import { idbGet, idbSet } from '../storage/idb.mjs';

const MIGRATIONS_URL = '/api/db/migrations.json';
const ENUMS_URL = '/api/db/enums.json';
const CACHE_MIGRATIONS_KEY = 'schemaMigrationsCache';
const CACHE_ENUMS_KEY = 'schemaEnumsCache';

// Mirrors the Go-side enums (applications.Statuses, communications.Channels/
// Directions/Statuses) fetched from /api/db/enums.json so dropdowns and
// normalizers stay in sync with the server without duplicating the lists.
// Start empty because ES modules can't await at import time; ensureSchema
// populates them during boot. Import as `let`-backed live bindings — read
// them after ensureSchema resolves.
export let APPLICATION_STATUSES = [];
export let COMMUNICATION_CHANNELS = [];
export let COMMUNICATION_DIRECTIONS = [];
export let COMMUNICATION_STATUSES = [];

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
// snapshot that predates versioned migrations). Mirrors the Go migrate loop.
const isBenignMigrationError = (err) => {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  return msg.includes('duplicate column');
};

export const ensureSchema = async () => {
  const { value: migrations, source: migrationsSource } = await fetchJSONWithCache(
    MIGRATIONS_URL, CACHE_MIGRATIONS_KEY,
  );
  const { value: enums, source: enumsSource } = await fetchJSONWithCache(
    ENUMS_URL, CACHE_ENUMS_KEY,
  );

  APPLICATION_STATUSES = enums.application_statuses || [];
  COMMUNICATION_CHANNELS = enums.communication_channels || [];
  COMMUNICATION_DIRECTIONS = enums.communication_directions || [];
  COMMUNICATION_STATUSES = enums.communication_statuses || [];

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
    // m.version is server-controlled (numeric field of an embedded file); no
    // untrusted input reaches this string.
    await exec(`PRAGMA user_version = ${Number(m.version)}`);
    applied.push(m.version);
  }

  const latest = ordered.length ? ordered[ordered.length - 1].version : current;
  console.log(`[schema] ready at v${latest} (migrations=${migrationsSource}, enums=${enumsSource}, applied=[${applied.join(',')}])`);
};
