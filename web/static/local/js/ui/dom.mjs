// Shared DOM helpers used across page modules.

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Renders a timestamp as YYYY-MM-DD in local time. Handles two input shapes
// that coexist in the DB: SQLite's naive "YYYY-MM-DD HH:MM:SS" (UTC by
// convention, no tz marker) and full ISO strings from `new Date().toISOString()`
// (already carry Z or an offset). Naive strings get 'Z' appended; ISO ones
// pass through untouched. Returns '' for falsy input.
const toLocalDate = (s) => {
  if (!s) return null;
  const raw = String(s).replace(' ', 'T');
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  const d = new Date(hasTz ? raw : raw + 'Z');
  return isNaN(d) ? null : d;
};

const pad = (n) => String(n).padStart(2, '0');

export const formatDate = (s) => {
  const d = toLocalDate(s);
  if (!d) return s ? String(s) : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Same conventions as formatDate but includes local HH:MM. Use for timeline
// events where the time of day matters.
export const formatDateTime = (s) => {
  const d = toLocalDate(s);
  if (!d) return s ? String(s) : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Human-readable byte count. "" for non-finite / negative input.
export const formatBytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
