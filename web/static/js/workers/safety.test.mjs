import { describe, expect, it } from 'vitest';
import { validatePdf, validateDocx, MAX_UPLOAD_BYTES } from './safety.mjs';

// bytesFromString builds a Uint8Array from a Latin-1 string. Convenient for
// PDF fixtures where the payload is ASCII and we don't want to hand-assemble
// byte arrays.
const bytesFromString = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

// ------------------- PDF -------------------

describe('validatePdf', () => {
  it('accepts a plain PDF with the %PDF- magic prefix', () => {
    expect(() => validatePdf(bytesFromString('%PDF-1.4\nsome text\n%%EOF'))).not.toThrow();
  });

  it('rejects bytes without %PDF- magic', () => {
    expect(() => validatePdf(bytesFromString('not a pdf'))).toThrowError(/pdf_bad_magic/);
  });

  it('rejects a truncated 4-byte input', () => {
    expect(() => validatePdf(bytesFromString('%PDF'))).toThrowError(/pdf_bad_magic/);
  });

  it('rejects encrypted PDFs (via /Encrypt substring)', () => {
    expect(() => validatePdf(bytesFromString('%PDF-1.7\n<< /Encrypt 1 0 R >>')))
      .toThrowError(/pdf_encrypted/);
  });

  // The `%PDF-` magic + all remaining active-content keys we still refuse.
  const ACTIVE = ['/Launch', '/SubmitForm', '/ImportData', '/RichMedia', '/Movie', '/Sound', '/XFA'];
  for (const key of ACTIVE) {
    it(`rejects PDFs containing ${key}`, () => {
      expect(() => validatePdf(bytesFromString(`%PDF-1.4\n<< ${key} (x) >>`)))
        .toThrowError(new RegExp(`pdf_active_content:${key.replace(/\//g, '\\/')}`));
    });
  }

  // Keys we intentionally dropped for false-positive reasons — must not throw.
  const ALLOWED = ['/OpenAction', '/EmbeddedFile', '/AA', '/JS', '/JavaScript'];
  for (const key of ALLOWED) {
    it(`accepts PDFs containing ${key} (dropped from the refuse list)`, () => {
      expect(() => validatePdf(bytesFromString(`%PDF-1.4\n<< ${key} (x) >>`))).not.toThrow();
    });
  }
});

// ------------------- DOCX helpers -------------------

// buildZip synthesizes a minimal ZIP archive from an array of entries. Each
// entry gets a stored (no-compression) local file header + a matching central
// directory record + an End of Central Directory record. The output is real
// enough for safety.mjs's central-directory walker to parse without needing
// a full zip library in tests.
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

const buildZip = (entries) => {
  const chunks = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    const dataBytes = new TextEncoder().encode(e.body || '');
    const compressedSize = e.compressedSize ?? dataBytes.length;
    const uncompressedSize = e.uncompressedSize ?? dataBytes.length;

    // Local file header
    const local = [
      ...le32(0x04034b50),        // signature
      ...le16(20),                // version needed
      ...le16(0),                 // flags
      ...le16(0),                 // method — stored
      ...le16(0), ...le16(0),     // time/date
      ...le32(0),                 // crc32 (not checked by our walker)
      ...le32(compressedSize),
      ...le32(uncompressedSize),
      ...le16(nameBytes.length),
      ...le16(0),                 // extra length
      ...nameBytes,
      ...dataBytes,
    ];
    chunks.push(...local);

    // Central directory record — matches what walkDocxEntries reads.
    const cd = [
      ...le32(0x02014b50),        // signature
      ...le16(20), ...le16(20),   // version made by / needed
      ...le16(0),                 // flags
      ...le16(0),                 // method
      ...le16(0), ...le16(0),     // time/date
      ...le32(0),                 // crc32
      ...le32(compressedSize),
      ...le32(uncompressedSize),
      ...le16(nameBytes.length),
      ...le16(0),                 // extra length
      ...le16(0),                 // comment length
      ...le16(0),                 // disk number
      ...le16(0),                 // internal attrs
      ...le32(0),                 // external attrs
      ...le32(offset),            // local header offset
      ...nameBytes,
    ];
    centrals.push(...cd);
    offset += local.length;
  }

  const cdOffset = chunks.length;
  chunks.push(...centrals);

  const eocd = [
    ...le32(0x06054b50),
    ...le16(0), ...le16(0),           // disk numbers
    ...le16(entries.length),
    ...le16(entries.length),
    ...le32(centrals.length),         // CD size
    ...le32(cdOffset),
    ...le16(0),                       // comment length
  ];
  chunks.push(...eocd);

  return new Uint8Array(chunks);
};

const minimalDocxEntries = [
  { name: '[Content_Types].xml', body: '<Types/>' },
  { name: 'word/document.xml', body: '<w:document/>' },
];

// ------------------- DOCX -------------------

describe('validateDocx', () => {
  it('accepts a minimal well-formed docx', () => {
    expect(() => validateDocx(buildZip(minimalDocxEntries))).not.toThrow();
  });

  it('rejects an archive with no EOCD (not a zip)', () => {
    expect(() => validateDocx(new Uint8Array([0, 1, 2, 3, 4, 5])))
      .toThrowError(/docx_bad_zip/);
  });

  it('rejects a zip missing word/document.xml', () => {
    expect(() => validateDocx(buildZip([{ name: '[Content_Types].xml', body: '<x/>' }])))
      .toThrowError(/docx_missing_document_xml/);
  });

  it('rejects VBA macros (word/vbaProject.bin)', () => {
    const entries = [
      ...minimalDocxEntries,
      { name: 'word/vbaProject.bin', body: 'MZ' },
    ];
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_forbidden:macros/);
  });

  it('rejects VBA macros case-insensitively', () => {
    const entries = [
      ...minimalDocxEntries,
      { name: 'word/VBAProject.BIN', body: 'MZ' },
    ];
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_forbidden:macros/);
  });

  it('rejects ActiveX parts', () => {
    const entries = [
      ...minimalDocxEntries,
      { name: 'word/activeX/activeX1.xml', body: '<x/>' },
    ];
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_forbidden:activex/);
  });

  it('rejects OLE embeddings', () => {
    const entries = [
      ...minimalDocxEntries,
      { name: 'word/embeddings/oleObject1.bin', body: 'blob' },
    ];
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_forbidden:ole_embeddings/);
  });

  it('rejects absolute paths (zip-slip)', () => {
    const entries = [
      ...minimalDocxEntries,
      { name: '/etc/passwd', body: 'root:x' },
    ];
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_zip_slip/);
  });

  it('rejects traversal paths (zip-slip)', () => {
    const entries = [
      ...minimalDocxEntries,
      { name: '../../etc/passwd', body: 'root:x' },
    ];
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_zip_slip/);
  });

  it('rejects zip-bomb ratios (> 100:1)', () => {
    const entries = [
      ...minimalDocxEntries,
      { name: 'bomb.bin', body: 'a', compressedSize: 1, uncompressedSize: 200 },
    ];
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_zip_bomb_ratio/);
  });

  it('rejects >200 entries', () => {
    const entries = [...minimalDocxEntries];
    for (let i = 0; i < 201; i++) entries.push({ name: `pad/${i}.xml`, body: '<x/>' });
    expect(() => validateDocx(buildZip(entries))).toThrowError(/docx_too_many_entries/);
  });
});

// ------------------- exports -------------------

describe('MAX_UPLOAD_BYTES', () => {
  it('is 10 MiB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
