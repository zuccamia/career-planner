// Brag entries — accomplishments the LLM can pull from when tailoring
// resumes or outreach. Optional company_id groups entries by "what I did at
// Stripe" without requiring it (some entries are between-jobs, personal
// projects, etc.).

import { exec } from '../db/client.mjs';

const EDITABLE_COLS = ['title', 'body', 'impact', 'tags_json', 'tags_generated_at', 'company_id', 'entry_year'];

const normalize = (data) => ({
  title: (data.title ?? '').toString().trim(),
  body: (data.body ?? '').toString(),
  impact: (data.impact ?? '').toString().trim(),
  tags_json: JSON.stringify(Array.isArray(data.tags) ? data.tags : (data.tags_json ? JSON.parse(data.tags_json) : [])),
  tags_generated_at: data.tags_generated_at || null,
  company_id: data.company_id ? Number(data.company_id) : null,
  entry_year: data.entry_year ? Number(data.entry_year) : null,
});

const hydrate = (row) => {
  if (!row) return row;
  const out = { ...row };
  try { out.tags = JSON.parse(row.tags_json || '[]'); }
  catch { out.tags = []; }
  return out;
};

export const listBragEntries = async () => {
  const rows = await exec(`
    SELECT b.*, c.official_name AS company_name
    FROM brag_entries b
    LEFT JOIN companies c ON c.id = b.company_id
    ORDER BY b.entry_year DESC NULLS LAST, b.updated_at DESC, b.id DESC
  `);
  return rows.map(hydrate);
};

export const countBragEntries = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM brag_entries');
  return Number(rows[0]?.n ?? 0);
};

export const getBragEntry = async (id) => {
  const rows = await exec('SELECT * FROM brag_entries WHERE id = ?', [id]);
  return hydrate(rows[0] || null);
};

// listByCompany — the primary consumer for later LLM resume-tailoring: pull
// every accomplishment the user recorded against this company.
export const listBragEntriesByCompany = async (companyID) => {
  const rows = await exec(
    `SELECT * FROM brag_entries WHERE company_id = ?
     ORDER BY entry_year DESC NULLS LAST, updated_at DESC, id DESC`,
    [companyID],
  );
  return rows.map(hydrate);
};

export const createBragEntry = async (data) => {
  const n = normalize(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `INSERT INTO brag_entries (${EDITABLE_COLS.join(', ')})
     VALUES (${EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const updateBragEntry = async (id, data) => {
  const n = normalize(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `UPDATE brag_entries
     SET ${EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

export const deleteBragEntry = (id) =>
  exec('DELETE FROM brag_entries WHERE id = ?', [id]);
