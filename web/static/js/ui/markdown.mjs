// Thin wrapper around vendored snarkdown so callers import a stable path
// and we can swap the renderer later without touching call sites.

import snarkdown from '../../vendor/snarkdown/snarkdown.mjs';

// Snarkdown does NOT escape raw HTML in the source — a signals containing
// `<script>` would pass through unfiltered. safety.mjs only guards against
// prompt-injection *markers*, not XSS payloads. So we escape `<`, `>`, and
// `&` up front; markdown syntax (`#`, `-`, `*`, `_`, `` ` ``) is untouched
// and snarkdown still tokenizes them normally.
const escapeHtmlEntities = (raw) => String(raw ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export const renderMarkdown = (md) => snarkdown(escapeHtmlEntities(md));
