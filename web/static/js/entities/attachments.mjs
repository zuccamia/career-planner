// Polymorphic attachments — metadata rows in SQLite, blobs on the storage
// backends (see storage/attachments.mjs for the upload coordinator).
//
// The blob's on-backend location is (folder, filename). We store both because
// folder is picked at upload time from something mutable (company_name); the
// row must remember what name it wrote under regardless of later renames.

import { exec } from '../db/client.mjs';
import { removeAttachment } from '../storage/attachments.mjs';

export const listAttachmentsByEntity = (entityType, entityID) => exec(
  `SELECT id, entity_type, entity_id, folder, filename, original_filename,
          mime_type, size_bytes, sha256, created_at
   FROM attachments
   WHERE entity_type = ? AND entity_id = ?
   ORDER BY datetime(created_at) DESC, id DESC`,
  [entityType, entityID],
);

// Bulk delete used by entity DELETEs (deleteApplication, deleteResume) — the
// attachments table has no FK on the polymorphic entity_id, so parent entity
// modules can't rely on cascade and route through here instead. On-disk blobs
// stay put (paired siblings may reference them; deferred GC sweeps the rest).
export const deleteAttachmentsByEntity = (entityType, entityID) =>
  exec('DELETE FROM attachments WHERE entity_type = ? AND entity_id = ?', [entityType, entityID]);

// createAttachment records the metadata row *after* the coordinator has
// written the bytes to every available backend. It does not touch storage
// itself — callers pass in the return value of uploadAttachment().
export const createAttachment = async ({
  entity_type, entity_id,
  folder, filename, original_filename,
  mime_type = '', size_bytes = 0, sha256 = '',
}) => {
  if (!entity_type) throw new Error('entity_type required');
  if (!entity_id) throw new Error('entity_id required');
  if (!folder) throw new Error('folder required');
  if (!filename) throw new Error('filename required');
  await exec(
    `INSERT INTO attachments
       (entity_type, entity_id, folder, filename, original_filename,
        mime_type, size_bytes, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entity_type, entity_id, folder, filename,
     original_filename || filename,
     mime_type, size_bytes, sha256],
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

// Deletes the blob (best-effort fan-out) and every attachment row pointing
// at it. Sibling cascade handles the resume↔application pair from
// linkPdfToApplication: both rows share folder+filename (unique per upload),
// so deleting either removes the pair — no orphaned metadata.
export const deleteAttachment = async (id) => {
  const rows = await exec(
    'SELECT folder, filename FROM attachments WHERE id = ?',
    [id],
  );
  const row = rows[0];
  if (!row) return;
  try { await removeAttachment(row.folder, row.filename); }
  catch (err) { console.warn('deleteAttachment: blob delete failed:', err); }
  await exec(
    'DELETE FROM attachments WHERE folder = ? AND filename = ?',
    [row.folder, row.filename],
  );
};
