# Typst.ts (vendored)

In-browser Typst compiler used by
`web/static/local/js/workers/typst-client.mjs` to render `.typ` resumes to
PDF entirely client-side. No external network at compile time.

## Files

- `all-in-one-lite.bundle.js` — the `@myriaddreamin/typst.ts` ES bundle that
  installs the global `$typst` API.
  Source: https://cdn.jsdelivr.net/npm/@myriaddreamin/typst.ts@0.7.0/dist/esm/contrib/all-in-one-lite.bundle.js
- `typst_ts_web_compiler_bg.wasm` — the Typst compiler WASM (~27 MB).
  Source: https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm
- `typst_ts_renderer_bg.wasm` — Typst renderer WASM (~1 MB), used when the
  page previews SVG. Not required for PDF export, but small enough to keep.
  Source: https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.7.0/pkg/typst_ts_renderer_bg.wasm

## License

Apache-2.0 — see typst.ts LICENSE at
https://github.com/Myriad-Dreamin/typst.ts/blob/main/LICENSE

## Notes

Typst is a modern typesetting system with a self-contained compiler — no
texmf-dist tree, no format files to fetch, no package server dependencies.
That's why we swapped away from SwiftLaTeX (which needed a texlive endpoint
that has since gone offline).

To upgrade, bump the `@0.7.0` in the URLs above and re-download.
