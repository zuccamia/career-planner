// Communications CRUD: threads + entries. Column shape matches
// internal/communications/model.go so snapshots round-trip with the Go side.
//
// Threads are always scoped to a person (person_id NOT NULL); entries always
// scoped to a thread. ON DELETE CASCADE on both FKs means deleting a person
// removes their threads and every entry underneath.

import { exec } from '../db/client.mjs';
import { COMMUNICATION_CHANNELS, COMMUNICATION_DIRECTIONS, COMMUNICATION_STATUSES } from '../db/schema.mjs';

export { COMMUNICATION_CHANNELS, COMMUNICATION_DIRECTIONS, COMMUNICATION_STATUSES };

const THREAD_EDITABLE_COLS = ['person_id', 'channel', 'subject', 'status'];
const ENTRY_EDITABLE_COLS = ['thread_id', 'direction', 'content', 'occurred_at'];

// ---------- normalization ----------
// Mirrors normalizeChannel/normalizeDirection/normalizeStatus in
// internal/communications/service.go — unknown values fall back to a safe
// default rather than raising.
const normalizeOneOf = (value, allowed, fallback) => {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
};

const normalizeChannel = (v) => normalizeOneOf(v, COMMUNICATION_CHANNELS, 'email');
const normalizeDirection = (v) => normalizeOneOf(v, COMMUNICATION_DIRECTIONS, 'note');
const normalizeStatus = (v) => normalizeOneOf(v, COMMUNICATION_STATUSES, 'open');

// ---------- threads ----------

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
  return rows[0].n;
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

export const updateThread = async (id, data) => {
  const subject = (data.subject ?? '').trim();
  if (!subject) throw new Error('subject required');
  await exec(
    `UPDATE communication_threads
     SET channel = ?, subject = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [normalizeChannel(data.channel), subject, id],
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

// ---------- entries ----------

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
  await exec(
    `INSERT INTO communication_entries (${ENTRY_EDITABLE_COLS.join(', ')})
     VALUES (${ENTRY_EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  await recomputeThreadActivity(threadID);
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const deleteEntry = async (id) => {
  const rows = await exec(
    'SELECT thread_id FROM communication_entries WHERE id = ?',
    [id],
  );
  const threadID = rows[0]?.thread_id;
  await exec('DELETE FROM communication_entries WHERE id = ?', [id]);
  if (threadID) await recomputeThreadActivity(threadID);
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
