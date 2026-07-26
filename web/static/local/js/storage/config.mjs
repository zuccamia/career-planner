// Constants + tiny shared helpers for the storage backends.

export const GOOGLE_CONFIG_ENDPOINT = '/oauth/google/config';
export const GOOGLE_TOKEN_ENDPOINT = '/oauth/google/token';
export const GOOGLE_REDIRECT_URI = `${location.origin}/static/local/oauth-callback.html`;

export const SNAPSHOT_PREFIX = 'snapshot-';
export const SNAPSHOT_SUFFIX = '.sqlite';
// Separator between the timestamp and a user-provided label.
// Two underscores because single '-' already appears in the timestamp;
// presence of this delimiter also flags a snapshot as "labeled" for retention.
export const SNAPSHOT_LABEL_SEP = '__';
export const ATTACHMENTS_FOLDER_NAME = 'Career Planner - Attachments';

// Google Drive REST endpoints. Split into three so multipart uploads and
// media downloads (which use different subdomains / paths) each get their
// own base — no ad-hoc concatenation in the backend.
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const driveFileURL = (id, params = '') =>
  `${DRIVE_API}/files/${id}${params ? `?${params}` : ''}`;
export const driveFilesListURL = (params) => `${DRIVE_API}/files?${params}`;
export const driveMultipartUploadURL = (params) =>
  `${DRIVE_UPLOAD}/files?${params}`;

// Timestamped snapshot filename (yyyymmdd-hhmmss).
export const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Sanitize a user-provided label to lowercase kebab-case, [a-z0-9-] only,
// capped at 40 chars. Empty result means "no label".
export const sanitizeSnapshotLabel = (raw) => {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
};

export const snapshotFilename = (d = new Date(), label = '') => {
  const clean = sanitizeSnapshotLabel(label);
  const suffix = clean ? `${SNAPSHOT_LABEL_SEP}${clean}` : '';
  return `${SNAPSHOT_PREFIX}${stamp(d)}${suffix}${SNAPSHOT_SUFFIX}`;
};

// A snapshot is "labeled" (user-named, keep forever) iff the filename
// contains the label separator. Auto-generated snapshots do not.
export const isLabeledSnapshot = (name) =>
  typeof name === 'string' && name.includes(SNAPSHOT_LABEL_SEP);

// Fetches the OAuth client ID + scopes from the server (which reads them
// from GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_SCOPES). Cached after the first
// successful call so subsequent OAuth flows don't re-fetch. Returns
// { clientID, scopes }.
let googleOAuthConfigPromise = null;
export const getGoogleOAuthConfig = () => {
  if (!googleOAuthConfigPromise) {
    googleOAuthConfigPromise = fetch(GOOGLE_CONFIG_ENDPOINT).then(async (res) => {
      if (!res.ok) {
        googleOAuthConfigPromise = null;
        throw new Error(`google oauth not configured (HTTP ${res.status})`);
      }
      const { client_id, scopes } = await res.json();
      if (!client_id) {
        googleOAuthConfigPromise = null;
        throw new Error('google oauth config missing client_id');
      }
      return { clientID: client_id, scopes: scopes || '' };
    });
  }
  return googleOAuthConfigPromise;
};
