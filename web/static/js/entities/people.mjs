// People CRUD against the local sqlite DB. Column shape matches
// internal/people/model.go so snapshots round-trip between the browser and Go.
//
// Note: `people.company_id` is nullable — a person may exist without a
// company. Callers responsible for resolving a company name to an id (see
// entities/companies.mjs findCompanyByName).

import { exec } from '../db/client.mjs';
import { sanitizeURL } from '../ui/dom.mjs';

const EDITABLE_COLS = ['full_name', 'title', 'company_id', 'social_url', 'notes'];

// Joins companies so callers can render the company name without a second
// round-trip. Ordered by name for deterministic listing.
export const listPeople = () => exec(`
  SELECT p.id, p.full_name, p.title, p.company_id,
         c.official_name AS company_name,
         p.social_url, p.notes,
         p.created_at, p.updated_at
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
