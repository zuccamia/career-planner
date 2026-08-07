// Google Drive backend with two auth flows:
//   - Live server (hosted): PKCE authorization-code flow whose token exchange
//     is proxied through /oauth/google/token so client_secret stays server-
//     side. Refresh tokens are persisted in IDB so users stay signed in
//     across days.
//   - Static build (GH Pages, isStaticHost): Google Identity Services
//     (initTokenClient) — pure browser, no server. Access tokens only; when
//     one expires we ask GIS for a silent refresh, and fall back to
//     interactive consent if that fails. No client_secret required.
// Snapshots go to the hidden appDataFolder (invisible on drive.google.com).
// Attachments go to a visible "Career Planner - Attachments" folder so the
// user can grab files directly from Drive without opening the app.

import { idbGet, idbSet, idbDel } from './idb.mjs';
import { isStaticHost } from '../host.mjs';
import {
  getGoogleOAuthConfig, GOOGLE_TOKEN_ENDPOINT, GOOGLE_REDIRECT_URI,
  ATTACHMENTS_FOLDER_NAME, snapshotFilename,
  driveFileURL, driveFilesListURL, driveMultipartUploadURL,
} from './config.mjs';

const REFRESH_TOKEN_KEY = 'googleRefreshToken';
const GIS_CONSENT_KEY = 'googleGisConsented';
const ATTACHMENTS_FOLDER_KEY = 'googleAttachmentsFolderId';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

// ---------- PKCE helpers ----------
const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomVerifier = () => {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
};
const sha256B64Url = async (str) => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64url(new Uint8Array(hash));
};

export class GoogleDriveBackend {
  constructor() {
    this.name = 'google-drive';
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.refreshToken = null;
    this._attachmentsFolder = null;
    // Per-entity subfolder ID cache. Keyed by sanitized folder name (e.g., "google").
    // Lives only in memory — cheap to rebuild via Drive search on next boot.
    this._entityFolders = new Map();
  }

  static isSupported() { return true; }
  isReady() { return !!this.refreshToken || !!this.accessToken || !!this._gisConsented; }
  isAvailable() { return this.isReady() && navigator.onLine; }

  async tryRestore() {
    if (isStaticHost()) {
      this._gisConsented = !!(await idbGet(GIS_CONSENT_KEY));
      return this._gisConsented;
    }
    this.refreshToken = await idbGet(REFRESH_TOKEN_KEY);
    return !!this.refreshToken;
  }

  async signOut() {
    if (this.accessToken && isStaticHost() && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(this.accessToken, () => {});
    }
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.refreshToken = null;
    this._gisConsented = false;
    this._attachmentsFolder = null;
    this._entityFolders.clear();
    await idbDel(REFRESH_TOKEN_KEY);
    await idbDel(GIS_CONSENT_KEY);
  }

  async connect() {
    if (isStaticHost()) return this._connectGIS();
    return this._connectPKCE();
  }

  async refresh() {
    if (isStaticHost()) return this._refreshGIS();
    return this._refreshPKCE();
  }

  async _connectPKCE() {
    const { clientID, scopes } = await getGoogleOAuthConfig();
    const verifier = randomVerifier();
    const challenge = await sha256B64Url(verifier);
    const state = randomVerifier().slice(0, 24);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientID);
    authUrl.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('include_granted_scopes', 'true');

    const popup = window.open(authUrl.toString(), 'google-oauth', 'width=520,height=640');
    if (!popup) throw new Error('popup blocked — allow popups for this site and retry');

    const code = await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (popup.closed) { cleanup(); reject(new Error('popup closed before completing sign-in')); }
      }, 500);
      const onMessage = (ev) => {
        if (ev.origin !== location.origin) return;
        const d = ev.data;
        if (!d || d.source !== 'career-planner-oauth') return;
        cleanup();
        if (d.error) return reject(new Error(`${d.error}: ${d.errorDescription || ''}`));
        if (d.state !== state) return reject(new Error('OAuth state mismatch — possible CSRF'));
        if (!d.code) return reject(new Error('no auth code returned'));
        resolve(d.code);
      };
      const cleanup = () => { clearInterval(timer); window.removeEventListener('message', onMessage); };
      window.addEventListener('message', onMessage);
    });

    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: GOOGLE_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      throw new Error(`token exchange failed: ${tokenRes.status} ${t}`);
    }
    const tok = await tokenRes.json();
    this.accessToken = tok.access_token;
    this.accessTokenExpiresAt = Date.now() + (tok.expires_in - 60) * 1000;
    if (tok.refresh_token) {
      this.refreshToken = tok.refresh_token;
      await idbSet(REFRESH_TOKEN_KEY, this.refreshToken);
    }
  }

  async _refreshPKCE() {
    if (!this.refreshToken) throw new Error('no refresh token — sign in again');
    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`token refresh failed: ${res.status} ${t}`);
    }
    const tok = await res.json();
    this.accessToken = tok.access_token;
    this.accessTokenExpiresAt = Date.now() + (tok.expires_in - 60) * 1000;
  }

  // Google Identity Services flow — pure browser, no server exchange, no
  // refresh token. First sign-in prompts the user; subsequent access-token
  // renewals use `prompt: ''` for silent renewal against the active Google
  // session. If the user has signed out of Google, silent renewal fails and
  // the caller must invoke connect() again for a fresh consent.
  async _connectGIS() { return this._requestGISToken({ prompt: 'consent' }); }
  async _refreshGIS() { return this._requestGISToken({ prompt: '' }); }

  async _requestGISToken(opts) {
    const client = await this._gisTokenClient();
    const tok = await new Promise((resolve, reject) => {
      client.callback = (resp) => {
        if (resp && resp.access_token) return resolve(resp);
        reject(new Error(resp?.error_description || resp?.error || 'GIS token request failed'));
      };
      client.error_callback = (err) => reject(new Error(err?.message || err?.type || 'GIS error'));
      client.requestAccessToken(opts);
    });
    this.accessToken = tok.access_token;
    this.accessTokenExpiresAt = Date.now() + (tok.expires_in - 60) * 1000;
    this._gisConsented = true;
    await idbSet(GIS_CONSENT_KEY, true);
  }

  async _gisTokenClient() {
    if (this._tokenClient) return this._tokenClient;
    await this._loadGISLibrary();
    const { clientID, scopes } = await getGoogleOAuthConfig();
    this._tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientID,
      scope: scopes,
      callback: () => {}, // overridden per requestAccessToken()
    });
    return this._tokenClient;
  }

  _loadGISLibrary() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this._gisLoadPromise) return this._gisLoadPromise;
    this._gisLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SCRIPT_URL;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load Google Identity Services'));
      document.head.appendChild(s);
    });
    return this._gisLoadPromise;
  }

  async ensureAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    await this.refresh();
    return this.accessToken;
  }

  async apiFetch(url, init = {}) {
    const token = await this.ensureAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`drive api ${res.status}: ${t.slice(0, 200)}`);
    }
    return res;
  }

  async saveSnapshot(bytes, { label = '' } = {}) {
    const createdAt = new Date();
    const filename = snapshotFilename(createdAt, label);
    const body = await this._multipartBody({ name: filename, parents: ['appDataFolder'] }, 'application/vnd.sqlite3', bytes);
    const res = await this.apiFetch(
      driveMultipartUploadURL('uploadType=multipart&fields=id,name,size,createdTime'),
      { method: 'POST', body },
    );
    const file = await res.json();
    return {
      id: file.id,
      name: file.name,
      createdAt: new Date(file.createdTime),
      sizeBytes: Number(file.size ?? bytes.byteLength),
    };
  }

  async listSnapshots() {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: "name contains 'snapshot-' and trashed = false",
      orderBy: 'createdTime desc',
      pageSize: '100',
      fields: 'files(id,name,size,createdTime)',
    });
    const res = await this.apiFetch(driveFilesListURL(params));
    const data = await res.json();
    return (data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      createdAt: new Date(f.createdTime),
      sizeBytes: Number(f.size ?? 0),
    }));
  }

  async loadSnapshot(id) {
    const res = await this.apiFetch(driveFileURL(id, 'alt=media'));
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteSnapshot(id) {
    await this.apiFetch(driveFileURL(id), { method: 'DELETE' });
  }

  async _attachmentsFolderId() {
    if (this._attachmentsFolder) return this._attachmentsFolder;
    const cached = await idbGet(ATTACHMENTS_FOLDER_KEY);
    if (cached) {
      try {
        await this.apiFetch(driveFileURL(cached, 'fields=id,trashed'));
        this._attachmentsFolder = cached;
        return cached;
      } catch { /* fall through, recreate */ }
    }
    const q = new URLSearchParams({
      q: `name='${ATTACHMENTS_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)',
      pageSize: '1',
    });
    const searchRes = await this.apiFetch(driveFilesListURL(q));
    const found = (await searchRes.json()).files?.[0];
    let id;
    if (found) {
      id = found.id;
    } else {
      const createRes = await this.apiFetch(driveFilesListURL('fields=id'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ATTACHMENTS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      });
      id = (await createRes.json()).id;
    }
    this._attachmentsFolder = id;
    await idbSet(ATTACHMENTS_FOLDER_KEY, id);
    return id;
  }

  // Escape a value for use inside a single-quoted Drive `q` string literal.
  // Backslashes and apostrophes are the only characters that break the syntax.
  _escapeQ(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async _entityFolderId(folder) {
    if (this._entityFolders.has(folder)) return this._entityFolders.get(folder);
    const parent = await this._attachmentsFolderId();
    const escaped = this._escapeQ(folder);
    const q = new URLSearchParams({
      q: `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: '1',
    });
    const searchRes = await this.apiFetch(driveFilesListURL(q));
    const found = (await searchRes.json()).files?.[0];
    let id;
    if (found) {
      id = found.id;
    } else {
      const createRes = await this.apiFetch(driveFilesListURL('fields=id'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: folder,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parent],
        }),
      });
      id = (await createRes.json()).id;
    }
    this._entityFolders.set(folder, id);
    return id;
  }

  async hasAttachment(folder, filename) {
    if (!this.isReady()) return false;
    try {
      const parent = await this._entityFolderId(folder);
      const q = new URLSearchParams({
        q: `name='${this._escapeQ(filename)}' and '${parent}' in parents and trashed=false`,
        fields: 'files(id)',
        pageSize: '1',
      });
      const res = await this.apiFetch(driveFilesListURL(q));
      return !!(await res.json()).files?.length;
    } catch { return false; }
  }

  async saveAttachment(folder, filename, bytes) {
    const parent = await this._entityFolderId(folder);
    const body = await this._multipartBody(
      { name: filename, parents: [parent] },
      'application/octet-stream',
      bytes,
    );
    await this.apiFetch(driveMultipartUploadURL('uploadType=multipart&fields=id'), {
      method: 'POST', body,
    });
    return { storedFilename: filename, sizeBytes: bytes.byteLength };
  }

  async loadAttachment(folder, filename) {
    const parent = await this._entityFolderId(folder);
    const q = new URLSearchParams({
      q: `name='${this._escapeQ(filename)}' and '${parent}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: '1',
    });
    const listRes = await this.apiFetch(driveFilesListURL(q));
    const file = (await listRes.json()).files?.[0];
    if (!file) throw new Error(`attachment not found on Drive: ${folder}/${filename}`);
    const res = await this.apiFetch(driveFileURL(file.id, 'alt=media'));
    return new Uint8Array(await res.arrayBuffer());
  }

  // Idempotent: a missing file is not an error (404).
  async deleteAttachment(folder, filename) {
    if (!this.isReady()) throw new Error('not connected');
    const parent = await this._entityFolderId(folder);
    const q = new URLSearchParams({
      q: `name='${this._escapeQ(filename)}' and '${parent}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: '1',
    });
    const listRes = await this.apiFetch(driveFilesListURL(q));
    const file = (await listRes.json()).files?.[0];
    if (!file) return;
    await this.apiFetch(driveFileURL(file.id), { method: 'DELETE' });
  }

  async _multipartBody(metadata, contentType, bytes) {
    const boundary = '----cp-boundary-' + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const parts = [
      enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      enc.encode(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
      bytes,
      enc.encode(`\r\n--${boundary}--`),
    ];
    return new Blob(parts, { type: `multipart/related; boundary=${boundary}` });
  }
}
