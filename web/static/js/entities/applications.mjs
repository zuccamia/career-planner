// Applications CRUD against the local sqlite DB. Column shape matches
// internal/applications/model.go so snapshots exported from the browser are
// legible by the Go side (and vice versa).
//
// Note: `applications.company_id` is NOT NULL with a FK to companies(id).
// Callers responsible for resolving a company name to an id (see
// entities/companies.mjs findOrCreateCompanyByName).
//
// Timeline events (keyed by application_id, ON DELETE CASCADE) live alongside
// the base CRUD so callers get consistent auto-emit behavior from
// create/update — mirroring internal/applications/service.go.

import { exec, transaction } from '../db/client.mjs';
import { APPLICATION_STATUSES } from '../db/schema.mjs';
import { sanitizeURL } from '../ui/dom.mjs';
import { t } from '../i18n.mjs';
import { deleteAttachmentsByEntity } from './attachments.mjs';

export { APPLICATION_STATUSES };

const EDITABLE_COLS = [
  'company_id', 'person_id',
  'role_title', 'job_posting_url',
  'job_description_raw', 'job_description_extracted_json',
  'status', 'notes',
];

const ALLOWED_EVENT_TYPES = new Set(['created', 'status_changed', 'note', 'artifact_added']);

// Joins companies so callers can render the company name without a second
// round-trip. person_id/person_name deferred until the people module lands.
export const listApplications = () => exec(`
  SELECT a.id, a.company_id, c.official_name AS company_name,
         a.person_id, p.full_name AS person_name,
         a.role_title, a.job_posting_url, a.status,
         a.created_at, a.updated_at
  FROM applications a
  LEFT JOIN companies c ON c.id = a.company_id
  LEFT JOIN people p ON p.id = a.person_id
  ORDER BY datetime(a.updated_at) DESC, a.id DESC
`);

// Skips the companies JOIN on purpose — the only caller (company detail
// page) already has the company name in hand. listApplicationsByPerson
// (below) DOES join because "person → applications" spans multiple
// companies.
export const listApplicationsByCompany = (companyID) => exec(`
  SELECT id, company_id, role_title, status, created_at, updated_at
  FROM applications
  WHERE company_id = ?
  ORDER BY datetime(updated_at) DESC, id DESC
`, [companyID]);

export const listApplicationsByPerson = (personID) => exec(`
  SELECT a.id, a.company_id, c.official_name AS company_name,
         a.role_title, a.status, a.created_at, a.updated_at
  FROM applications a
  LEFT JOIN companies c ON c.id = a.company_id
  WHERE a.person_id = ?
  ORDER BY datetime(a.updated_at) DESC, a.id DESC
`, [personID]);

export const getApplication = async (id) => {
  const rows = await exec(`
    SELECT a.*, c.official_name AS company_name,
           p.full_name AS person_name
    FROM applications a
    LEFT JOIN companies c ON c.id = a.company_id
    LEFT JOIN people p ON p.id = a.person_id
    WHERE a.id = ?
  `, [id]);
  return rows[0] || null;
};

// createApplicationEvent inserts a timeline row. Callers pass application_id +
// type; the write helpers below auto-emit `created` and `status_changed`.
// UI code can call directly to add ad-hoc `note` events.
export const createApplicationEvent = async ({
  application_id, type = 'note', content = '',
  from_status = '', to_status = '', occurred_at = null,
}) => {
  if (!application_id) throw new Error('application_id required');
  const eventType = ALLOWED_EVENT_TYPES.has(type) ? type : 'note';
  const trimmed = (content ?? '').trim();
  if (eventType === 'note' && !trimmed) throw new Error('event content is required');
  if (eventType === 'status_changed' && !to_status) throw new Error('destination status is required');

  await exec(
    `INSERT INTO application_events
       (application_id, type, content, from_status, to_status, occurred_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    [application_id, eventType, trimmed, from_status || '', to_status || '', occurred_at || null],
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

// Sanitizes a create/update payload and asserts the FK. company_id is
// required in the schema, so no callable path should reach persistence
// without it — this is the single gate.
const sanitizeApplicationFields = (data) => {
  if (!data.company_id) throw new Error('company_id required');
  return {
    company_id: data.company_id,
    person_id: data.person_id ?? null,
    role_title: (data.role_title ?? '').trim(),
    job_posting_url: sanitizeURL(data.job_posting_url),
    job_description_raw: data.job_description_raw ?? '',
    job_description_extracted_json: data.job_description_extracted_json ?? '{}',
    status: data.status ?? 'lead',
    notes: (data.notes ?? '').trim(),
  };
};

export const createApplication = async (data) => {
  const n = sanitizeApplicationFields(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  return transaction(async () => {
    await exec(
      `INSERT INTO applications (${EDITABLE_COLS.join(', ')})
       VALUES (${EDITABLE_COLS.map(() => '?').join(', ')})`,
      values,
    );
    const rows = await exec('SELECT last_insert_rowid() AS id');
    const id = rows[0].id;
    await createApplicationEvent({ application_id: id, type: 'created', to_status: n.status });
    return id;
  });
};

// updateApplication persists field changes and emits a status_changed event
// when the status transitions. Non-status edits do NOT produce timeline
// entries — the timeline is a status-only history.
export const updateApplication = async (id, data) => {
  const n = sanitizeApplicationFields(data);

  const before = await getApplication(id);
  if (!before) throw new Error(t('applications.error.not_found', { id }));

  const values = EDITABLE_COLS.map(c => n[c]);
  await transaction(async () => {
    await exec(
      `UPDATE applications
       SET ${EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
           updated_at = datetime('now')
       WHERE id = ?`,
      [...values, id],
    );
    const after = await getApplication(id);
    if (before.status !== after.status) {
      await createApplicationEvent({
        application_id: id,
        type: 'status_changed',
        from_status: before.status,
        to_status: after.status,
        occurred_at: after.updated_at,
      });
    }
  });
};

// updateApplicationStatus flips only the status and records a status_changed
// event with an explicit occurred_at + note — mirrors the legacy quick-status
// widget. No-op when the status is unchanged (matches Service.UpdateStatus).
export const updateApplicationStatus = async ({ id, status, occurred_at, notes }) => {
  const before = await getApplication(id);
  if (!before) throw new Error(t('applications.error.not_found', { id }));
  if (!status || before.status === status) return before;

  await transaction(async () => {
    await exec(
      `UPDATE applications
       SET status = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [status, id],
    );
    await createApplicationEvent({
      application_id: id,
      type: 'status_changed',
      content: notes || '',
      from_status: before.status,
      to_status: status,
      occurred_at: occurred_at || null,
    });
  });
  return getApplication(id);
};

// updateApplicationExtraction persists an LLM-extracted JD payload (and the
// resolved raw text, which the server may have fetched from the posting URL).
// Used by the "Extract description" affordance on the detail page.
export const updateApplicationExtraction = async (id, { structuredJson, jobDescriptionRaw }) => {
  const raw = jobDescriptionRaw ?? '';
  await exec(
    `UPDATE applications
     SET job_description_extracted_json = ?,
         job_description_raw = CASE WHEN ? != '' THEN ? ELSE job_description_raw END,
         updated_at = datetime('now')
     WHERE id = ?`,
    [structuredJson || '{}', raw, raw, id],
  );
};

// Deletes the application + its attachment rows. Timeline events cascade
// via FK; attachments have no FK on the polymorphic entity_id, so manual
// cleanup via deleteAttachmentsByEntity. Paired resume-side rows and on-disk
// blobs stay (still referenced).
export const deleteApplication = async (id) => {
  await transaction(async () => {
    await deleteAttachmentsByEntity('application', id);
    await exec('DELETE FROM applications WHERE id = ?', [id]);
  });
};

// Wipe every application from the local DB while leaving companies, people,
// and communications intact. Meant for starting a new time-period snapshot
// on top of the same longer-lived reference data. Order:
//   1. attachments rows for entity_type='application' — polymorphic, no FK
//      cascade would delete these on their own.
//   2. applications — application_events cascades via ON DELETE CASCADE.
// Attachment blob files on disk/Drive are not touched; they become orphaned
// and will be swept by the (still-deferred) blob GC pass.
export const clearAllApplications = async () => {
  const before = await countApplications();
  await exec(`DELETE FROM attachments WHERE entity_type = 'application'`);
  await exec(`DELETE FROM applications`);
  return { deleted: before };
};

export const countApplications = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM applications');
  return Number(rows[0]?.n ?? 0);
};

// Most recently updated application's status per company. Companies with no
// applications are absent from the map.
export const topStatusByCompany = async () => {
  const rows = await exec(`
    SELECT company_id, status
    FROM applications
    ORDER BY datetime(updated_at) DESC, id DESC
  `);
  const best = new Map();
  for (const r of rows) {
    if (!best.has(r.company_id)) best.set(r.company_id, r.status);
  }
  return best;
};

// Roll a raw status into one of the six headline pill values plus withdrawn.
export const headlineStatus = (s) => {
  if (!s) return 'lead';
  if (['online_assessment', 'first_interview', 'second_interview', 'additional_interview'].includes(s)) return 'interview';
  return s;
};

export const countApplicationsByCompany = async () => {
  const rows = await exec(`
    SELECT company_id, COUNT(*) AS n
    FROM applications
    GROUP BY company_id
  `);
  return new Map(rows.map(r => [r.company_id, r.n]));
};

// countApplicationsByStatus returns a Map<status, n>. Absent statuses have no
// entry — callers should treat missing as 0.
export const countApplicationsByStatus = async () => {
  const rows = await exec(`
    SELECT status, COUNT(*) AS n
    FROM applications
    GROUP BY status
  `);
  return new Map(rows.map(r => [r.status, r.n]));
};

// listStatusTransitionCounts returns aggregated status_changed events grouped
// by (from_status, to_status). Mirrors internal/applications/repository.go so
// the dashboard sankey reads the same on both surfaces.
export const listStatusTransitionCounts = () => exec(`
  SELECT from_status, to_status, COUNT(*) AS n
  FROM application_events
  WHERE type = 'status_changed'
    AND from_status <> ''
    AND to_status <> ''
    AND from_status <> to_status
  GROUP BY from_status, to_status
`);

// listDailyAppliedCounts returns per-day counts of status_changed events
// where to_status='applied' within [startISO, endISO). occurred_at is stored
// as UTC ISO; the bucket uses the 'localtime' modifier so an event at
// 2026-07-16 22:00 local (2026-07-17 02:00 UTC) is grouped under 2026-07-16.
export const listDailyAppliedCounts = (startISO, endISO) => exec(`
  SELECT substr(datetime(occurred_at, 'localtime'), 1, 10) AS day, COUNT(*) AS n
  FROM application_events
  WHERE type = 'status_changed'
    AND to_status = 'applied'
    AND datetime(occurred_at) >= datetime(?)
    AND datetime(occurred_at) <  datetime(?)
  GROUP BY day
  ORDER BY day
`, [startISO, endISO]);

// ---------- timeline events ----------

export const listEventsByApplication = (applicationID) => exec(
  `SELECT id, application_id, type, content, from_status, to_status,
          occurred_at, created_at, updated_at
   FROM application_events
   WHERE application_id = ?
   ORDER BY datetime(occurred_at) DESC, id DESC`,
  [applicationID],
);


