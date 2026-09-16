// Row-level diff between the live DB and a backend snapshot. Loads the
// snapshot bytes into a scratch DB attached as `backend`, then FULL OUTER
// JOINs each diff-worthy table on id. Returns added / removed / modified
// rows with column-level change lists for modified. Informational only —
// no writes. Always pair with diffClose in a finally block.

import { exec, diffOpen, diffClose } from '../db/client.mjs';

// Per-table label priority — which columns to pick a human-readable row name
// from. Tables discovered at runtime but absent from this map fall back to
// `['id']`, so a newly-added user table shows up in diffs with `#<id>` labels
// until someone curates its entry here.
const TABLE_LABELS = {
  applications:          ['role_title', 'id'],
  application_events:    ['type', 'id'],
  companies:             ['official_name', 'display_name', 'id'],
  dossiers:              ['company_id', 'id'],
  people:                ['full_name', 'id'],
  communication_threads: ['subject', 'id'],
  communication_entries: ['id'],
  brag_entries:          ['title', 'id'],
  resumes:               ['title', 'id'],
  profile_overview:      ['headline', 'id'],
  attachments:           ['original_filename', 'filename', 'id'],
};

// Preferred display order — curated tables first, then discovered-unknown
// tables alphabetically. Keeps the UI stable while accommodating new tables.
const TABLE_ORDER = Object.keys(TABLE_LABELS);

// List user tables to diff, read from sqlite_master. Excludes sqlite internals
// and FTS5 virtual/shadow tables (matched by the `_fts` naming convention we
// use in migrations). Tables without an `id` column are filtered later by
// diffTable's `no_id` branch, so FTS shadows that slip through are still safe.
const listDiffTables = async () => {
  const rows = await exec(
    `SELECT name FROM main.sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '%_fts'
       AND name NOT LIKE '%_fts_%'`
  );
  const names = rows.map(r => r.name);
  const rank = new Map(TABLE_ORDER.map((n, i) => [n, i]));
  return names.sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    return ra - rb || a.localeCompare(b);
  });
};

// Columns that shouldn't count as "changed" — noisy or derived and would
// flag every row as modified after a re-sync.
const IGNORED_COLS = new Set(['updated_at', 'created_at', 'tags_generated_at']);

// Read PRAGMA table_info for one table in one schema. Returns [] if the
// table doesn't exist in that schema (older snapshot missing a table added
// by a later migration, or vice versa).
const tableColumns = async (schema, table) => {
  try {
    const rows = await exec(`PRAGMA ${schema}.table_info(${table})`);
    return rows.map(r => r.name);
  } catch { return []; }
};

// Diff one table. Returns { table, added, removed, modified }. Modified
// entries carry a `changes` array of { column, before, after } pairs.
const diffTable = async ({ table, labels }) => {
  const [mainCols, backendCols] = await Promise.all([
    tableColumns('main', table),
    tableColumns('backend', table),
  ]);
  if (mainCols.length === 0 && backendCols.length === 0) {
    return { table, added: [], removed: [], modified: [], skipped: 'missing' };
  }
  // Common columns only — a schema-drift column is treated as ignored, not
  // an error. Callers see it as "no change" rather than a crash.
  const cols = mainCols.filter(c => backendCols.includes(c) && !IGNORED_COLS.has(c));
  if (!cols.includes('id')) {
    return { table, added: [], removed: [], modified: [], skipped: 'no_id' };
  }

  const colList = cols.map(c => `"${c}"`).join(', ');
  const selectA = cols.map(c => `m."${c}" AS "a_${c}"`).join(', ');
  const selectB = cols.map(c => `b."${c}" AS "b_${c}"`).join(', ');
  const rows = await exec(`
    SELECT m.id AS main_id, b.id AS backend_id, ${selectA}, ${selectB}
    FROM main.${table} m
    FULL OUTER JOIN backend.${table} b ON m.id = b.id
  `);

  const added = [];    // present locally, absent on backend
  const removed = [];  // present on backend, absent locally
  const modified = []; // present both, at least one column differs

  for (const row of rows) {
    const inMain = row.main_id != null;
    const inBackend = row.backend_id != null;
    if (inMain && !inBackend) {
      added.push({ id: row.main_id, label: pickLabel(row, 'a_', labels) });
      continue;
    }
    if (!inMain && inBackend) {
      removed.push({ id: row.backend_id, label: pickLabel(row, 'b_', labels) });
      continue;
    }
    const changes = [];
    for (const col of cols) {
      if (col === 'id') continue;
      const before = row[`b_${col}`];
      const after = row[`a_${col}`];
      if (!valuesEqual(before, after)) changes.push({ column: col, before, after });
    }
    if (changes.length > 0) {
      modified.push({ id: row.main_id, label: pickLabel(row, 'a_', labels), changes });
    }
  }
  return { table, added, removed, modified };
};

// First non-null candidate from `labels`; falls back to `#<id>`.
const pickLabel = (row, prefix, labels) => {
  for (const col of labels) {
    const value = row[`${prefix}${col}`];
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return `#${row[`${prefix}id`] ?? '?'}`;
};

// SQLite numbers and strings round-trip cleanly; null-vs-empty is a false
// positive we suppress. Deep-object diffs would need JSON.stringify but our
// TEXT columns already store JSON as strings, so byte-equality works.
const valuesEqual = (a, b) => {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return a === '' || b === '' ? true : false;
  return String(a) === String(b);
};

// Public entry: diff local DB against the snapshot represented by `bytes`.
// Returns { tables: [...perTableResult] }. Skipped tables are included so the
// UI can note schema drift; empty tables (no changes) are dropped from the
// return so the UI's "no changes" branch is a simple length check.
export const diffAgainstSnapshot = async (bytes) => {
  await diffOpen(bytes);
  try {
    const tableNames = await listDiffTables();
    const perTable = await Promise.all(tableNames.map(table =>
      diffTable({ table, labels: TABLE_LABELS[table] || ['id'] })
    ));
    const tables = perTable.filter(t =>
      t.skipped || t.added.length || t.removed.length || t.modified.length
    );
    return { tables };
  } finally {
    try { await diffClose(); } catch (err) { console.warn('[diff] could not release snapshot scratch DB — next diff will reclaim it:', err.message); }
  }
};
