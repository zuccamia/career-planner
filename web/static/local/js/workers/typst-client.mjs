// Typst compile client. Wraps the "all-in-one-lite" bundle from
// @myriaddreamin/typst.ts (Apache-2.0) — see web/static/vendor/typst/. The
// bundle installs a global `$typst` object; its compiler/renderer modules
// point at the same-origin vendored WASM so no external network is needed.
//
// Loaded lazily so users on markdown resumes don't pay the ~30 MB WASM cost.

const VENDOR_DIR = '/static/vendor/typst/';
const BUNDLE_URL = VENDOR_DIR + 'all-in-one-lite.bundle.js';
const COMPILER_WASM = VENDOR_DIR + 'typst_ts_web_compiler_bg.wasm';
const RENDERER_WASM = VENDOR_DIR + 'typst_ts_renderer_bg.wasm';

let bootPromise = null;

const boot = () => {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    // The all-in-one-lite bundle is an ES module that installs `$typst` as a
    // window global. Import it once; subsequent calls reuse the same instance.
    await import(BUNDLE_URL);
    if (typeof globalThis.$typst === 'undefined') {
      throw new Error('typst.ts bundle loaded but $typst global is missing');
    }
    globalThis.$typst.setCompilerInitOptions({ getModule: () => COMPILER_WASM });
    globalThis.$typst.setRendererInitOptions({ getModule: () => RENDERER_WASM });
    return globalThis.$typst;
  })();
  return bootPromise;
};

// compileTypstToPdf(source) -> { pdf: Uint8Array, log: string }
// Throws on compile error. The thrown Error carries a human-friendly `message`
// plus the raw dump on `log` (for the collapsible diagnostic panel) and a
// `code` for callers that want to localize the top-level line.
export const compileTypstToPdf = async (source) => {
  const $typst = await boot();
  try {
    const pdf = await $typst.pdf({ mainContent: String(source || '') });
    return { pdf, log: '' };
  } catch (err) {
    const raw = err?.message || String(err) || 'Typst compile failed';
    const parsed = parseTypstDiagnostics(raw);
    const wrapped = new Error(parsed.message);
    wrapped.log = raw;
    wrapped.code = parsed.code;
    wrapped.diagnostics = parsed.diagnostics;
    throw wrapped;
  }
};

// parseTypstDiagnostics extracts the human-readable `message: "..."` clauses
// from a SourceDiagnostic array dump and classifies common patterns. Multiple
// "is not valid in code" diagnostics are a strong tell that the source isn't
// actually Typst (e.g. Markdown, plain text, or another notation).
const parseTypstDiagnostics = (raw) => {
  const diagnostics = [...raw.matchAll(/message:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
  const invalidInCode = diagnostics.filter(m => m.includes('is not valid in code')).length;
  if (invalidInCode >= 2) {
    return { code: 'not_typst_source', message: 'not_typst_source', diagnostics };
  }
  if (diagnostics.length > 0) {
    return { code: 'diagnostics', message: diagnostics.slice(0, 3).join(' · '), diagnostics };
  }
  return { code: 'unknown', message: raw, diagnostics: [] };
};
