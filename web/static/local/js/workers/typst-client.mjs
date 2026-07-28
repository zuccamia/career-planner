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
// Throws on compile error. Typst diagnostics come back via the thrown Error's
// message; preserved as-is so the profile page can render them.
export const compileTypstToPdf = async (source) => {
  const $typst = await boot();
  try {
    const pdf = await $typst.pdf({ mainContent: String(source || '') });
    return { pdf, log: '' };
  } catch (err) {
    const wrapped = new Error(err?.message || String(err) || 'Typst compile failed');
    wrapped.log = err?.stack || '';
    throw wrapped;
  }
};
