// Companies CRUD against the local sqlite DB. Mirrors the shape of
// internal/companies/model.go — same column names, same fields.

import { exec } from '../db/client.mjs';

const EDITABLE_COLS = ['official_name', 'website', 'tech_blog_url', 'ats_url', 'ats_provider'];

export const countCompanies = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM companies');
  return Number(rows[0]?.n ?? 0);
};

export const listCompanies = () => exec(`
  SELECT id, official_name, website, tech_blog_url, ats_url, ats_provider,
         created_at, updated_at
  FROM companies
  ORDER BY official_name COLLATE NOCASE
`);

export const getCompany = async (id) => {
  const rows = await exec('SELECT * FROM companies WHERE id = ?', [id]);
  return rows[0] || null;
};

export const findCompanyByName = async (name) => {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const rows = await exec(
    'SELECT * FROM companies WHERE official_name = ? COLLATE NOCASE LIMIT 1',
    [trimmed],
  );
  return rows[0] || null;
};

export const createCompany = async (data) => {
  const values = EDITABLE_COLS.map(c => data[c] ?? '');
  await exec(
    `INSERT INTO companies (${EDITABLE_COLS.join(', ')})
     VALUES (${EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const updateCompany = async (id, data) => {
  const values = EDITABLE_COLS.map(c => data[c] ?? '');
  await exec(
    `UPDATE companies
     SET ${EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

export const deleteCompany = (id) =>
  exec('DELETE FROM companies WHERE id = ?', [id]);

export const countEngineeringBlogsByCompany = async () => {
  const rows = await exec(`
    SELECT company_id, COUNT(*) AS n
    FROM engineering_blog_notes
    GROUP BY company_id
  `);
  return new Map(rows.map(r => [r.company_id, r.n]));
};
