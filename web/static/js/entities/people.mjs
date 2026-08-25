// People + communication threads/entries CRUD against the local sqlite DB.
// Column shape matches internal/people/model.go so snapshots round-trip
// between the browser and Go.
//
// Note: `people.company_id` is nullable — a person may exist without a
// company. Callers responsible for resolving a company name to an id (see
// entities/companies.mjs findCompanyByName).
//
// Threads are always scoped to a person (person_id NOT NULL); entries always
// scoped to a thread. ON DELETE CASCADE on both FKs means deleting a person
// removes their threads and every entry underneath.

import { exec, transaction } from '../db/client.mjs';
import { COMMUNICATION_CHANNELS, COMMUNICATION_DIRECTIONS, COMMUNICATION_STATUSES } from '../db/schema.mjs';
import { sanitizeURL } from '../ui/dom.mjs';

export { COMMUNICATION_CHANNELS, COMMUNICATION_DIRECTIONS, COMMUNICATION_STATUSES };

// ---- people ----

const EDITABLE_COLS = ['full_name', 'title', 'company_id', 'social_url', 'notes'];

// Joins companies so callers can render the company name without a second
// round-trip. Ordered by name for deterministic listing.
export const listPeople = () => exec(`
  SELECT p.id, p.full_name, p.title, p.company_id,
         c.official_name AS company_name,
         p.social_url, p.notes,
         p.created_at, p.updated_at,
         (SELECT MAX(last_activity_at) FROM communication_threads
            WHERE person_id = p.id) AS last_activity_at
  FROM people p
  LEFT JOIN companies c ON c.id = p.company_id
  ORDER BY p.full_name COLLATE NOCASE
`);

// Skips the companies JOIN on purpose — the only caller (company detail
// page) already has the company name in hand. Mirrors the intentional
// asymmetry in entities/applications.mjs's listApplicationsByCompany.
export const listPeopleByCompanyID = (companyID) => exec(`
  SELECT id, full_name, title, company_id, social_url, notes,
         created_at, updated_at
  FROM people
  WHERE company_id = ?
  ORDER BY full_name COLLATE NOCASE
`, [companyID]);

export const getPerson = async (id) => {
  const rows = await exec(`
    SELECT p.*, c.official_name AS company_name
    FROM people p
    LEFT JOIN companies c ON c.id = p.company_id
    WHERE p.id = ?
  `, [id]);
  return rows[0] || null;
};

export const findPersonByName = async (name) => {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const rows = await exec(
    'SELECT * FROM people WHERE full_name = ? COLLATE NOCASE LIMIT 1',
    [trimmed],
  );
  return rows[0] || null;
};

// Sanitizes a create/update payload and asserts required fields. Every
// persistence path goes through here — single gate for the full_name
// invariant. company_id is nullable (a person may exist without a company),
// so no assert there; empty strings and zero coerce to null to keep the FK
// consistent with the Go side.
const sanitizePersonFields = (data) => {
  const full_name = (data.full_name ?? '').trim();
  if (!full_name) throw new Error('full_name required');
  return {
    full_name,
    title: (data.title ?? '').trim(),
    company_id: data.company_id ? Number(data.company_id) : null,
    social_url: sanitizeURL(data.social_url),
    notes: data.notes ?? '',
  };
};

export const createPerson = async (data) => {
  const n = sanitizePersonFields(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `INSERT INTO people (${EDITABLE_COLS.join(', ')})
     VALUES (${EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const updatePerson = async (id, data) => {
  const n = sanitizePersonFields(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `UPDATE people
     SET ${EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

export const deletePerson = (id) =>
  exec('DELETE FROM people WHERE id = ?', [id]);

export const countPeople = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM people');
  return Number(rows[0]?.n ?? 0);
};

export const countPeopleByCompany = async () => {
  const rows = await exec(`
    SELECT company_id, COUNT(*) AS n
    FROM people
    WHERE company_id IS NOT NULL
    GROUP BY company_id
  `);
  return new Map(rows.map(r => [r.company_id, r.n]));
};

// ---- threads ----

const THREAD_EDITABLE_COLS = ['person_id', 'channel', 'subject', 'status'];
const ENTRY_EDITABLE_COLS = ['thread_id', 'direction', 'content', 'occurred_at'];

// Unknown values fall back to a safe default rather than raising, matching
// how the Go people package treats the same enum tokens on its side.
const normalizeOneOf = (value, allowed, fallback) => {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
};

const normalizeChannel = (v) => normalizeOneOf(v, COMMUNICATION_CHANNELS, 'email');
const normalizeDirection = (v) => normalizeOneOf(v, COMMUNICATION_DIRECTIONS, 'note');
const normalizeStatus = (v) => normalizeOneOf(v, COMMUNICATION_STATUSES, 'open');

// Joins people (+ optional company) so callers can render person_name and
// person_notes (used by the LLM RPCs) without a second round-trip.
const THREAD_SELECT = `
  SELECT t.id, t.person_id, p.full_name AS person_name, p.notes AS person_notes,
         t.channel, t.subject, t.status, t.summary,
         t.summary_updated_at, t.last_activity_at, t.created_at, t.updated_at
  FROM communication_threads t
  LEFT JOIN people p ON p.id = t.person_id
`;

export const listThreadsByPersonID = (personID) => exec(
  `${THREAD_SELECT} WHERE t.person_id = ? ORDER BY datetime(t.last_activity_at) DESC, t.id DESC`,
  [personID],
);

export const getThread = async (id) => {
  const rows = await exec(`${THREAD_SELECT} WHERE t.id = ?`, [id]);
  return rows[0] || null;
};

export const countThreadsByPersonID = async (personID) => {
  const rows = await exec(
    'SELECT COUNT(*) AS n FROM communication_threads WHERE person_id = ?',
    [personID],
  );
  return Number(rows[0]?.n ?? 0);
};

export const createThread = async (data) => {
  const personID = Number(data.person_id);
  if (!personID) throw new Error('person_id required');
  const subject = (data.subject ?? '').trim();
  if (!subject) throw new Error('subject required');
  const values = [personID, normalizeChannel(data.channel), subject, normalizeStatus(data.status ?? 'open')];
  await exec(
    `INSERT INTO communication_threads (${THREAD_EDITABLE_COLS.join(', ')})
     VALUES (${THREAD_EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

// updateThread accepts a partial patch. Only fields present in `patch` are
// written — `subject: 'foo'` alone will not touch channel/status. Trimmed
// empty subject is a hard error; unknown channel/status values fall back to
// the safe default (matches the normalize* helpers).
export const updateThread = async (id, patch) => {
  const cols = [];
  const values = [];
  if (Object.hasOwn(patch, 'subject')) {
    const subject = (patch.subject ?? '').trim();
    if (!subject) throw new Error('subject required');
    cols.push('subject = ?');
    values.push(subject);
  }
  if (Object.hasOwn(patch, 'channel')) {
    cols.push('channel = ?');
    values.push(normalizeChannel(patch.channel));
  }
  if (Object.hasOwn(patch, 'status')) {
    cols.push('status = ?');
    values.push(normalizeStatus(patch.status));
  }
  if (!cols.length) return;
  cols.push(`updated_at = datetime('now')`);
  await exec(
    `UPDATE communication_threads SET ${cols.join(', ')} WHERE id = ?`,
    [...values, id],
  );
};

export const updateThreadStatus = async (id, status) => {
  const s = normalizeStatus(status);
  await exec(
    `UPDATE communication_threads
     SET status = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [s, id],
  );
};

// Persists a summary returned by rpc.summarizeThread. Called by the page layer
// so the LLM RPC itself stays stateless.
export const updateThreadSummary = async (id, summary) => {
  await exec(
    `UPDATE communication_threads
     SET summary = ?, summary_updated_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [(summary ?? '').trim(), id],
  );
};

export const deleteThread = (id) =>
  exec('DELETE FROM communication_threads WHERE id = ?', [id]);

// ---- entries ----

export const listEntriesByThreadID = (threadID) => exec(`
  SELECT id, thread_id, direction, content, occurred_at, created_at, updated_at
  FROM communication_entries
  WHERE thread_id = ?
  ORDER BY datetime(occurred_at) DESC, id DESC
`, [threadID]);

// Recompute the parent thread's last_activity_at as MAX(occurred_at) across
// its remaining entries, so backfilling an older entry never drops the value
// and deleting the newest one refreshes it. Falls back to the thread's
// created_at when there are no entries left.
const recomputeThreadActivity = (threadID) => exec(
  `UPDATE communication_threads
   SET last_activity_at = COALESCE(
         (SELECT MAX(occurred_at) FROM communication_entries WHERE thread_id = ?),
         created_at
       ),
       updated_at = datetime('now')
   WHERE id = ?`,
  [threadID, threadID],
);

export const createEntry = async (data) => {
  const threadID = Number(data.thread_id);
  if (!threadID) throw new Error('thread_id required');
  const content = (data.content ?? '').trim();
  if (!content) throw new Error('content required');
  const occurredAt = data.occurred_at || new Date().toISOString();
  const values = [
    threadID,
    normalizeDirection(data.direction),
    content,
    occurredAt,
  ];
  return transaction(async () => {
    await exec(
      `INSERT INTO communication_entries (${ENTRY_EDITABLE_COLS.join(', ')})
       VALUES (${ENTRY_EDITABLE_COLS.map(() => '?').join(', ')})`,
      values,
    );
    const rows = await exec('SELECT last_insert_rowid() AS id');
    await recomputeThreadActivity(threadID);
    return rows[0].id;
  });
};

export const deleteEntry = async (id) => {
  await transaction(async () => {
    const rows = await exec(
      'SELECT thread_id FROM communication_entries WHERE id = ?',
      [id],
    );
    const threadID = rows[0]?.thread_id;
    await exec('DELETE FROM communication_entries WHERE id = ?', [id]);
    if (threadID) await recomputeThreadActivity(threadID);
  });
};

// listDailyEntryCounts returns per-day counts of communication_entries within
// [startISO, endISO). occurred_at is UTC ISO; the bucket uses 'localtime' so
// an entry at 2026-07-16 22:00 local buckets under 2026-07-16, not 2026-07-17.
export const listDailyEntryCounts = (startISO, endISO) => exec(`
  SELECT substr(datetime(occurred_at, 'localtime'), 1, 10) AS day, COUNT(*) AS n
  FROM communication_entries
  WHERE datetime(occurred_at) >= datetime(?)
    AND datetime(occurred_at) <  datetime(?)
  GROUP BY day
  ORDER BY day
`, [startISO, endISO]);
