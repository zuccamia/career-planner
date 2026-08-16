// Resumes — versioned resume documents. Body is authoritative source; format
// is 'md' or 'typ' (Typst). Compiled PDFs are derived artifacts tracked via
// the polymorphic attachments table (see resume-pdfs.mjs).

import { exec, transaction } from '../db/client.mjs';
import { deleteAttachmentsByEntity } from './attachments.mjs';

const EDITABLE_COLS = ['title', 'format', 'body'];
const ALLOWED_FORMATS = new Set(['md', 'typ']);

const sanitizeResumeFields = (data) => {
  const format = String(data.format ?? '').toLowerCase();
  return {
    title: (data.title ?? '').toString().trim(),
    format: ALLOWED_FORMATS.has(format) ? format : 'md',
    body: (data.body ?? '').toString(),
  };
};

// Coerces SQLite's 0/1 int to a real boolean so callers can `=== true` /
// truthy-check without silent mismatches.
const hydrateResume = (row) => (row ? { ...row, is_primary: !!row.is_primary } : row);

export const listResumes = async () => {
  const rows = await exec(
    `SELECT id, title, format, is_primary, created_at, updated_at
     FROM resumes
     ORDER BY is_primary DESC, datetime(updated_at) DESC, id DESC`,
  );
  return rows.map(hydrateResume);
};

export const countResumes = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM resumes');
  return Number(rows[0]?.n ?? 0);
};

export const getResume = async (id) => {
  const rows = await exec('SELECT * FROM resumes WHERE id = ?', [id]);
  return hydrateResume(rows[0] || null);
};

export const getPrimaryResume = async () => {
  const rows = await exec('SELECT * FROM resumes WHERE is_primary = 1 ORDER BY id ASC LIMIT 1');
  return hydrateResume(rows[0] || null);
};

export const createResume = async (data) => {
  const n = sanitizeResumeFields(data);
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
  const n = sanitizeResumeFields(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `UPDATE resumes
     SET ${EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

// Deletes the resume + its attachment rows via deleteAttachmentsByEntity
// (attachments have no FK on the polymorphic entity_id). Paired app-side rows
// and on-disk blobs stay (still referenced).
export const deleteResume = async (id) => {
  await transaction(async () => {
    await deleteAttachmentsByEntity('resume', id);
    await exec('DELETE FROM resumes WHERE id = ?', [id]);
  });
};

// setPrimary clears is_primary on every other row and sets it on this one, in
// one transaction. Passing null clears the flag from all rows (no primary).
export const setPrimaryResume = async (id) => {
  await transaction(async () => {
    await exec(`UPDATE resumes SET is_primary = 0, updated_at = datetime('now') WHERE is_primary = 1`);
    if (id) {
      await exec(`UPDATE resumes SET is_primary = 1, updated_at = datetime('now') WHERE id = ?`, [id]);
    }
  });
};
