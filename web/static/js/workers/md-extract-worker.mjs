// Web Worker that extracts Markdown from an uploaded PDF or DOCX résumé
// entirely in the browser. Runs off the main thread so the UI stays
// responsive during the ~100–500 ms parse of a typical CV.
//
// Vendored dependencies (upgrade instructions with each):
//   PDF  → /static/vendor/liteparse/liteparse_wasm.{js,wasm}
//          Bump @llamaindex/liteparse-wasm and re-download the two files
//          from https://cdn.jsdelivr.net/npm/@llamaindex/liteparse-wasm/pkg/
//   DOCX → /static/vendor/mammoth/mammoth.browser.min.js
//          Bump mammoth and re-download from
//          https://cdn.jsdelivr.net/npm/mammoth/mammoth.browser.min.js
//
// The DOCX pipeline emits HTML here; the main thread converts HTML → Markdown
// with turndown, which needs the browser's DOMParser (not available in
// workers). PDF pages come out as Markdown directly from liteparse.
//
// Protocol:
//   → main thread posts { id, bytes: Uint8Array }
//   ← worker replies { id, ok: true,  kind: 'pdf',  markdown, warnings }
//   ← worker replies { id, ok: true,  kind: 'docx', html,     warnings }
//   ← worker replies { id, ok: false, error }

import { validatePdf, validateDocx } from './safety.mjs';

// Compute the static root from this worker's URL rather than importing
// host.mjs — workers can't read the parent page's <meta> tags, and we only
// need the URL prefix anyway. This module lives at static/js/workers/, so
// two levels up (`../..`) lands in static/ with a trailing slash.
const STATIC_ROOT = new URL('../..', import.meta.url).href;
const VENDOR_LITEPARSE = `${STATIC_ROOT}vendor/liteparse/`;
const VENDOR_MAMMOTH = `${STATIC_ROOT}vendor/mammoth/mammoth.browser.min.js`;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const hasMagic = (bytes, magic) => {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
};

const sniffKind = (bytes) => {
  if (hasMagic(bytes, PDF_MAGIC)) return 'pdf';
  if (hasMagic(bytes, ZIP_MAGIC)) return 'docx';
  return 'unknown';
};

let liteparseInstance = null;
const getLiteParse = async () => {
  if (liteparseInstance) return liteparseInstance;
  const mod = await import(VENDOR_LITEPARSE + 'liteparse_wasm.js');
  await mod.default(VENDOR_LITEPARSE + 'liteparse_wasm_bg.wasm');
  // outputFormat: 'markdown' is what populates page.markdown with real
  // Markdown (headings, lists, bold/italic). Without it the field is
  // empty or falls back to the plain-text stream.
  liteparseInstance = new mod.LiteParse({ outputFormat: 'markdown' });
  return liteparseInstance;
};

// Load a UMD bundle inside the module worker. Mammoth doesn't publish
// an ESM build (only CJS + UMD), so `await import()` isn't an option;
// `importScripts()` isn't available in module workers either. Fetching
// the source and evaluating it in worker scope lets the UMD wrapper
// detect `self` and install its global.
const loadUmd = async (url, globalName) => {
  const src = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return r.text();
  });
  new Function(src)();
  if (typeof self[globalName] === 'undefined') {
    throw new Error(`${url} loaded but self.${globalName} is missing`);
  }
  return self[globalName];
};

let mammothPromise = null;
const getMammoth = () => {
  if (!mammothPromise) mammothPromise = loadUmd(VENDOR_MAMMOTH, 'mammoth');
  return mammothPromise;
};

const extractPdf = async (bytes) => {
  const parser = await getLiteParse();
  const result = await parser.parse(bytes);
  const markdown = (result.pages || [])
    .map((p) => p.markdown || p.text || '')
    .join('\n\n')
    .trim();
  const warnings = [];
  if (!markdown) warnings.push('no_text_extracted');
  return { markdown, warnings };
};

const extractDocx = async (bytes) => {
  const mammoth = await getMammoth();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  const warnings = (result.messages || [])
    .filter((m) => m.type === 'warning' || m.type === 'error')
    .map((m) => m.message);
  return { html: result.value || '', warnings };
};

self.addEventListener('message', async (event) => {
  const { id, bytes } = event.data || {};
  if (!bytes || !(bytes instanceof Uint8Array)) {
    self.postMessage({ id, ok: false, error: 'missing_bytes' });
    return;
  }
  const kind = sniffKind(bytes);
  try {
    if (kind === 'pdf') {
      validatePdf(bytes);
      const { markdown, warnings } = await extractPdf(bytes);
      self.postMessage({ id, ok: true, kind, markdown, warnings });
    } else if (kind === 'docx') {
      validateDocx(bytes);
      const { html, warnings } = await extractDocx(bytes);
      self.postMessage({ id, ok: true, kind, html, warnings });
    } else {
      self.postMessage({ id, ok: false, error: 'unsupported_kind' });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
