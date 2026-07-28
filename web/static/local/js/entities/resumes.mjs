// Resumes — versioned resume documents. Body is authoritative source; format
// is 'md' or 'typ' (Typst). Compiled PDFs are derived artifacts tracked via
// the polymorphic attachments table (see resume-pdfs.mjs).

import { exec, transaction } from '../db/client.mjs';

const EDITABLE_COLS = ['title', 'format', 'body'];
const ALLOWED_FORMATS = new Set(['md', 'typ']);

const normalize = (data) => ({
  title: (data.title ?? '').toString().trim(),
  format: ALLOWED_FORMATS.has(data.format) ? data.format : 'md',
  body: (data.body ?? '').toString(),
});

export const listResumes = () => exec(
  `SELECT id, title, format, is_primary, created_at, updated_at
   FROM resumes
   ORDER BY is_primary DESC, datetime(updated_at) DESC, id DESC`,
);

export const countResumes = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM resumes');
  return Number(rows[0]?.n ?? 0);
};

export const getResume = async (id) => {
  const rows = await exec('SELECT * FROM resumes WHERE id = ?', [id]);
  return rows[0] || null;
};

export const getPrimaryResume = async () => {
  const rows = await exec('SELECT * FROM resumes WHERE is_primary = 1 ORDER BY id ASC LIMIT 1');
  return rows[0] || null;
};

export const createResume = async (data) => {
  const n = normalize(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `INSERT INTO resumes (${EDITABLE_COLS.join(', ')})
     VALUES (${EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const updateResume = async (id, data) => {
  const n = normalize(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `UPDATE resumes
     SET ${EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

export const deleteResume = (id) =>
  exec('DELETE FROM resumes WHERE id = ?', [id]);

// setPrimary clears is_primary on every other row and sets it on this one, in
// one transaction. Passing null clears the flag from all rows (no primary).
export const setPrimaryResume = async (id) => {
  await transaction(async () => {
    await exec('UPDATE resumes SET is_primary = 0, updated_at = datetime(\'now\') WHERE is_primary = 1');
    if (id) {
      await exec('UPDATE resumes SET is_primary = 1, updated_at = datetime(\'now\') WHERE id = ?', [id]);
    }
  });
};
