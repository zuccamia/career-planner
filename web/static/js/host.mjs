// Reads the <meta name="static-host"> tag stamped into the layout by the Go
// template. true when the HTML was produced by pre-render tooling (no live
// server sitting behind /api/llm/*), false when it came from the live
// server. Missing tag falls back to false so unit tests and older cached
// HTML default to the hosted branch.

// STATIC_ROOT is the absolute URL of the /static/ directory this module was
// loaded from. Derived at runtime via import.meta.url so it works on every
// deploy shape (live server, GH Pages custom domain, GH Pages project page
// under /<repo>/). Callers concatenate paths under it, e.g.
// `${STATIC_ROOT}i18n/manifest.json`. This module lives at
// static/js/host.mjs, so one level up (`..`) lands in `static/`.
//
// Trailing slash is asserted defensively: WHATWG URL resolution should
// preserve it, but happy-dom (our vitest environment) has been observed
// dropping it, which turned `${STATIC_ROOT}i18n/...` into `staticI18n/...`.
const _staticRoot = new URL('..', import.meta.url).href;
export const STATIC_ROOT = _staticRoot.endsWith('/') ? _staticRoot : _staticRoot + '/';

const readMeta = () => {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector('meta[name=static-host]');
  return el?.getAttribute('content') === 'true';
};

let cached;

export const isStaticHost = () => {
  if (cached === undefined) cached = readMeta();
  return cached;
};

// Test-only: reset the memo between tests that stub the DOM.
export const _resetStaticHostForTests = () => { cached = undefined; };

// urlFor mirrors internal/http/local_handlers.go's urlForPage. All app pages
// live at the root (hosted) or under /{locale}/ (static), so a bare relative
// href resolves correctly. Static builds add .html before any query/hash.
export const urlFor = (page) => {
  if (!isStaticHost()) return page;
  const raw = String(page);
  const i = raw.search(/[?#]/);
  if (i < 0) return raw + '.html';
  return raw.slice(0, i) + '.html' + raw.slice(i);
};
