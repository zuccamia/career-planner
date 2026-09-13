// Copy attachment blobs across backends so every connected one has every row's
// file. Shares the 'attachments' Web Lock with upload/delete.

import { exec } from '../db/client.mjs';
import { availableBackends } from './index.mjs';
import { attachmentKey } from './config.mjs';
import { idbGet, idbSet } from './idb.mjs';

const UPLOAD_LOCK = 'attachments';
const LAST_RECONCILED_KEY = 'lastAttachmentReconcileAt';

export const getLastAttachmentReconcileAt = () => idbGet(LAST_RECONCILED_KEY);

const sha256Hex = async (bytes) => {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

// Returns {copied, inSync, missing:[{id,folder,filename}], errors, total}
// or {skipped:'need_two_backends', ...zeros}. onProgress fires per row.
export const reconcileAttachments = async ({ onProgress } = {}) => {
  return navigator.locks.request(UPLOAD_LOCK, async () => {
    const backends = availableBackends();
    if (backends.length < 2) {
      return { skipped: 'need_two_backends', copied: 0, missing: [], inSync: 0, errors: [], total: 0 };
    }

    const rows = await exec(
      `SELECT id, folder, filename, size_bytes, sha256 FROM attachments
       ORDER BY folder, filename`,
    );

    let copied = 0, inSync = 0;
    const missing = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = attachmentKey(row.folder, row.filename);
      const presence = await Promise.all(backends.map(async (b) => {
        try { return { b, has: await b.hasBlob(key) }; }
        catch (err) { return { b, has: false, err }; }
      }));

      const haves = presence.filter(p => p.has);
      const missings = presence.filter(p => !p.has);

      if (haves.length === 0) {
        missing.push({ id: row.id, folder: row.folder, filename: row.filename });
        onProgress?.({ done: i + 1, total: rows.length, row, action: 'missing_everywhere' });
        continue;
      }
      if (missings.length === 0) {
        inSync++;
        onProgress?.({ done: i + 1, total: rows.length, row, action: 'in_sync' });
        continue;
      }

      let bytes;
      try {
        bytes = await haves[0].b.readBlob(key);
      } catch (err) {
        errors.push({ id: row.id, folder: row.folder, filename: row.filename, stage: 'load', from: haves[0].b.name, error: err.message });
        onProgress?.({ done: i + 1, total: rows.length, row, action: 'error' });
        continue;
      }

      // Sha256 verify — catches corruption and stale collision names.
      if (row.sha256) {
        const hex = await sha256Hex(bytes);
        if (hex !== row.sha256) {
          errors.push({ id: row.id, folder: row.folder, filename: row.filename, stage: 'verify', expected: row.sha256, got: hex });
          onProgress?.({ done: i + 1, total: rows.length, row, action: 'error' });
          continue;
        }
      }

      let copiedHere = 0;
      for (const { b } of missings) {
        try {
          await b.writeBlob(key, new Uint8Array(bytes));
          copiedHere++;
        } catch (err) {
          errors.push({ id: row.id, folder: row.folder, filename: row.filename, stage: 'save', to: b.name, error: err.message });
        }
      }
      copied += copiedHere;
      onProgress?.({ done: i + 1, total: rows.length, row, action: 'copied',
                     from: haves[0].b.name, to: missings.map(m => m.b.name) });
    }

    await idbSet(LAST_RECONCILED_KEY, Date.now());
    return { copied, inSync, missing, errors, total: rows.length };
  });
};
