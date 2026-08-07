// Content-safety checks run inside the extract Web Worker before liteparse
// or mammoth touch the bytes. Because the browser sandbox is the actual
// runtime — no filesystem, no exec, no PDF JS engine, no Word macro engine —
// these checks are less about "block execution" and more about "refuse
// obviously weaponized files fast and cap resource use." Each throws a stable
// error code the UI maps to an i18n message.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// PDF ---------------------------------------------------------------------

const PDF_MAGIC = 'PDF-';

// Latin-1 decode preserves byte-value equality (0-255 → same code point) so
// substring scans on the resulting string match the raw byte sequences of
// ASCII PDF keywords.
const decodeLatin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

// Dictionary keys that only mean something to a JS-enabled viewer. Presence
// signals a weaponized PDF. Excluded from this list — each for a specific
// real-world false-positive reason:
//   /OpenAction    — every "open at page N / fit width" export uses this
//   /EmbeddedFile  — PDF/A-3 and Portfolio exports embed XMP attachments
//   /AA            — common in form templates
//   /JS            — substring-matches inside /JSON, /JSObject, etc.
//   /JavaScript    — appears as a form-action name in some benign PDFs
// The wasm parser has no runtime for any of these anyway; the check is a
// coarse upfront filter, not the primary safety boundary.
const PDF_ACTIVE_KEYS = [
  '/Launch', '/SubmitForm', '/ImportData',
  '/RichMedia', '/Movie', '/Sound', '/XFA',
];

export const validatePdf = (bytes) => {
  if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF' || bytes[4] !== 0x2d) {
    throw new Error('pdf_bad_magic');
  }
  const raw = decodeLatin1(bytes);
  if (raw.includes('/Encrypt')) throw new Error('pdf_encrypted');
  for (const key of PDF_ACTIVE_KEYS) {
    if (raw.includes(key)) throw new Error(`pdf_active_content:${key}`);
  }
};

// DOCX --------------------------------------------------------------------

const DOCX_MAX_ENTRIES = 200;
const DOCX_MAX_UNCOMPRESSED = 20 * 1024 * 1024;
const DOCX_MAX_RATIO = 100;

const DOCX_FORBIDDEN_EXACT = {
  'word/vbaproject.bin': 'macros',
  'word/vbadata.xml': 'macros',
};

const DOCX_FORBIDDEN_PREFIXES = [
  { prefix: 'word/activex/', reason: 'activex' },
  { prefix: 'word/embeddings/', reason: 'ole_embeddings' },
  { prefix: 'word/printersettings/', reason: 'printer_settings' },
];

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;

// Find the End Of Central Directory record. EOCD is 22 bytes plus an optional
// comment up to 65535 bytes; scan the tail rather than trust the file layout.
const findEocd = (v) => {
  const minStart = Math.max(0, v.byteLength - (22 + 65535));
  for (let i = v.byteLength - 22; i >= minStart; i--) {
    if (v.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new Error('docx_bad_zip');
};

// Enumerate central-directory entries. We only read name + sizes — enough
// to check zip-slip, forbidden parts, and zip-bomb heuristics without
// decompressing anything.
const walkDocxEntries = function* (bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(v);
  const totalEntries = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (totalEntries > DOCX_MAX_ENTRIES) throw new Error(`docx_too_many_entries:${totalEntries}`);

  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > v.byteLength || v.getUint32(offset, true) !== CD_SIGNATURE) {
      throw new Error('docx_bad_zip_cd');
    }
    const compressedSize = v.getUint32(offset + 20, true);
    const uncompressedSize = v.getUint32(offset + 24, true);
    const filenameLen = v.getUint16(offset + 28, true);
    const extraLen = v.getUint16(offset + 30, true);
    const commentLen = v.getUint16(offset + 32, true);
    const nameBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + offset + 46, filenameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    yield { name, compressedSize, uncompressedSize };
    offset += 46 + filenameLen + extraLen + commentLen;
  }
};

const cleanZipPath = (p) => p.replace(/\\/g, '/');

export const validateDocx = (bytes) => {
  let totalUncompressed = 0;
  let entryCount = 0;
  let haveDocumentXml = false;

  for (const entry of walkDocxEntries(bytes)) {
    entryCount++;
    const clean = cleanZipPath(entry.name);
    const lower = clean.toLowerCase();

    if (clean.startsWith('/') || clean.startsWith('..') || clean.includes('/../')) {
      throw new Error('docx_zip_slip');
    }
    const exact = DOCX_FORBIDDEN_EXACT[lower];
    if (exact) throw new Error(`docx_forbidden:${exact}`);
    for (const { prefix, reason } of DOCX_FORBIDDEN_PREFIXES) {
      if (lower.startsWith(prefix)) throw new Error(`docx_forbidden:${reason}`);
    }

    if (entry.compressedSize > 0) {
      const ratio = entry.uncompressedSize / entry.compressedSize;
      if (ratio > DOCX_MAX_RATIO) throw new Error(`docx_zip_bomb_ratio:${Math.round(ratio)}`);
    } else if (entry.uncompressedSize > 1024 * 1024) {
      // Stored (uncompressed) entry that is unexpectedly large.
      throw new Error(`docx_stored_oversize:${entry.uncompressedSize}`);
    }

    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > DOCX_MAX_UNCOMPRESSED) throw new Error('docx_zip_bomb_total');

    if (lower === 'word/document.xml') haveDocumentXml = true;
  }

  if (entryCount === 0) throw new Error('docx_empty');
  if (!haveDocumentXml) throw new Error('docx_missing_document_xml');
};
