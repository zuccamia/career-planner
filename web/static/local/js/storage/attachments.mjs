// Attachments coordinator. Sits above the storage backends and owns:
//   • folder-name sanitization (case-insensitive snake_case)
//   • cross-backend filename collision resolution (probe-first)
//   • cross-tab / cross-request serialization via Web Locks
//   • fan-out writes to every available backend
//   • prefer-local reads with Drive fallback
//
// Metadata rows live in SQLite (see entities/attachments.mjs). Blobs live on
// disk / Drive under `attachments/<folder>/<filename>`. Snapshot restore does
// NOT restore blobs — the metadata comes back, files are looked up live.

import { availableBackends, localDisk, googleDrive } from './index.mjs';

const UPLOAD_LOCK = 'attachments';

// Fold a company name (or any label) into a folder-safe, case-insensitive
// snake_case token. Empty / whitespace-only inputs fall back to "unassigned"
// so we never write to the attachments root by accident.
export const sanitizeFolder = (name) => {
  const s = (name || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'unassigned';
};

// Split "resume.pdf" -> ["resume", ".pdf"]; "archive.tar.gz" -> ["archive.tar", ".gz"];
// "README" -> ["README", ""]; ".env" -> [".env", ""].
const splitExt = (name) => {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return [name, ''];
  return [name.slice(0, idx), name.slice(idx)];
};

// Strip path separators from a user-picked filename. We keep unicode, spaces,
// punctuation — only `/` and `\` are fatal. Falls back to "file" if empty.
const sanitizeFilename = (name) => {
  const cleaned = (name || '').trim().replace(/[\\/]+/g, '-');
  return cleaned || 'file';
};

const sha256Hex = async (bytes) => {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

// Return a filename not currently taken on any of the given backends. Appends
// " (2)", " (3)", … before the extension until a free name is found. Bounded
// so a pathological folder can't spin forever.
const pickStoredFilename = async (backends, folder, desired) => {
  const [base, ext] = splitExt(desired);
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? desired : `${base} (${n})${ext}`;
    const hits = await Promise.all(backends.map(b => b.hasAttachment(folder, candidate)));
    if (!hits.some(Boolean)) return candidate;
  }
  throw new Error(`too many name collisions in folder "${folder}" for "${desired}"`);
};

// Upload a File to every available backend under `folder`. The Web Lock
// serializes the probe -> pick -> write sequence across tabs and against
// same-tab double-clicks, so the storedFilename returned here is consistent
// across all backends that participated in the write.
//
// Returns metadata the caller inserts into the attachments table.
export const uploadAttachment = async (folder, file) => {
  if (!file) throw new Error('no file provided');
  const buf = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(buf);
  const originalFilename = sanitizeFilename(file.name);
  const mimeType = file.type || '';

  return navigator.locks.request(UPLOAD_LOCK, async () => {
    const backends = availableBackends();
    if (backends.length === 0) {
      const err = new Error();
      err.code = 'no_storage_backend';
      throw err;
    }
    const storedFilename = await pickStoredFilename(backends, folder, originalFilename);
    // Each backend gets its own Uint8Array view; Drive multipart Blob may
    // retain the buffer, so we copy before handing over.
    for (const b of backends) {
      await b.saveAttachment(folder, storedFilename, new Uint8Array(buf));
    }
    return {
      folder,
      storedFilename,
      originalFilename,
      sha256,
      sizeBytes: buf.byteLength,
      mimeType,
    };
  });
};

// Read an attachment's bytes, preferring local disk over Drive. Callers get a
// Uint8Array; UI can wrap in a Blob to trigger a download.
export const downloadAttachment = async (folder, filename) => {
  const order = [localDisk, googleDrive].filter(b => b.isAvailable());
  let lastErr;
  for (const b of order) {
    try { return await b.loadAttachment(folder, filename); }
    catch (err) { lastErr = err; }
  }
  throw new Error(`attachment unreachable on any backend: ${folder}/${filename}${lastErr ? ` — ${lastErr.message}` : ''}`);
};
