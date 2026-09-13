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
  ATTACHMENTS_FOLDER_NAME, ATTACHMENTS_ROOT,
  driveFileURL, driveFilesListURL, driveMultipartUploadURL, DRIVE_UPLOAD,
} from './config.mjs';
import { BlobStore } from './blob_store.mjs';

const REFRESH_TOKEN_KEY = 'googleRefreshToken';
const GIS_CONSENT_KEY = 'googleGisConsented';
const ATTACHMENTS_FOLDER_KEY = 'googleAttachmentsFolderId';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
// Drive's magic parent alias for the hidden per-app data folder. Sync files
// (current.sqlite, <label>.sqlite) live here; attachments live in the visible
// "Career Planner - Attachments" folder tree.
const APP_DATA_FOLDER = 'appDataFolder';

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

export class GoogleDriveBackend extends BlobStore {
  constructor() {
    super();
    this.name = 'google-drive';
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.refreshToken = null;
    this._attachmentsFolder = null;
    // Sub-path → folder-ID cache (e.g. "attachments/google" → "0Bxyz…").
    // Memory-only; rebuilt via Drive search on boot. Concurrent find-or-create
    // calls are serialized via Web Locks keyed by path — see _resolveChildFolder.
    this._folderIdCache = new Map();
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
    this._folderIdCache.clear();
    await idbDel(REFRESH_TOKEN_KEY);
    await idbDel(GIS_CONSENT_KEY);
  }

  // BlobStore alias for the base contract; Settings UI uses signOut for its
  // semantic ("Sign out of Google Drive").
  forget() { return this.signOut(); }

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

  async listSnapshots() {
    const params = new URLSearchParams({
      spaces: APP_DATA_FOLDER,
      q: "trashed = false",
      orderBy: 'modifiedTime desc',
      pageSize: '100',
      fields: 'files(id,name,size,createdTime,modifiedTime)',
    });
    const res = await this.apiFetch(driveFilesListURL(params));
    const data = await res.json();
    return (data.files || [])
      .filter(f => typeof f.name === 'string' && f.name.endsWith('.sqlite'))
      .map(f => ({
        id: f.id,
        name: f.name,
        createdAt: new Date(f.modifiedTime || f.createdTime),
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

  // Escape a value for use inside a single-quoted Drive `q` string literal.
  _escapeQ(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // Resolve or create the top-level visible "Career Planner - Attachments"
  // folder. Cached in IDB across sessions. Web-lock-serialized so concurrent
  // callers (and other tabs) don't race to create duplicates.
  async _getOrCreateAttachmentsFolder(create) {
    if (this._attachmentsFolder) return this._attachmentsFolder;
    return navigator.locks.request('drive-folder:__root__', async () => {
      if (this._attachmentsFolder) return this._attachmentsFolder;
      return this._findOrCreateAttachmentsFolder(create);
    });
  }

  async _findOrCreateAttachmentsFolder(create) {
    const cached = await idbGet(ATTACHMENTS_FOLDER_KEY);
    if (cached) {
      try {
        await this.apiFetch(driveFileURL(cached, 'fields=id,trashed'));
        this._attachmentsFolder = cached;
        return cached;
      } catch { /* stale — recreate below */ }
    }
    const q = new URLSearchParams({
      q: `name='${ATTACHMENTS_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
      pageSize: '1',
    });
    const searchRes = await this.apiFetch(driveFilesListURL(q));
    const found = (await searchRes.json()).files?.[0];
    if (found) {
      this._attachmentsFolder = found.id;
    } else {
      if (!create) return null;
      const createRes = await this.apiFetch(driveFilesListURL('fields=id'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ATTACHMENTS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      });
      this._attachmentsFolder = (await createRes.json()).id;
    }
    await idbSet(ATTACHMENTS_FOLDER_KEY, this._attachmentsFolder);
    return this._attachmentsFolder;
  }

  async _findChildFolder(parentId, name) {
    const q = new URLSearchParams({
      q: `name='${this._escapeQ(name)}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: '1',
    });
    const res = await this.apiFetch(driveFilesListURL(q));
    return (await res.json()).files?.[0]?.id || null;
  }

  async _createChildFolder(parentId, name) {
    const res = await this.apiFetch(driveFilesListURL('fields=id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    return (await res.json()).id;
  }

  // Resolve a slash-delimited key to {parentId, name}. Returns null if the
  // path doesn't exist and create=false. Routes attachments/* to the visible
  // folder; anything else to appDataFolder.
  // Web-lock-serialized: concurrent callers for the same path — even across
  // tabs — wait on one another instead of racing to create duplicate folders.
  async _resolveChildFolder(parentId, seg, cacheKey, create) {
    if (this._folderIdCache.has(cacheKey)) return this._folderIdCache.get(cacheKey);
    return navigator.locks.request(`drive-folder:${cacheKey}`, async () => {
      if (this._folderIdCache.has(cacheKey)) return this._folderIdCache.get(cacheKey);
      let id = await this._findChildFolder(parentId, seg);
      if (!id) {
        if (!create) return null;
        id = await this._createChildFolder(parentId, seg);
      }
      this._folderIdCache.set(cacheKey, id);
      return id;
    });
  }

  async _resolveParent(key, { create = false } = {}) {
    const parts = key.split('/');
    const name = parts.pop();
    if (parts.length === 0) return { parentId: APP_DATA_FOLDER, name };
    if (parts[0] !== ATTACHMENTS_ROOT) {
      throw new Error(`unrecognized key root: ${parts[0]}`);
    }
    const attachmentsId = await this._getOrCreateAttachmentsFolder(create);
    if (!attachmentsId) return null;
    let parentId = attachmentsId;
    const trail = [ATTACHMENTS_ROOT];
    for (const seg of parts.slice(1)) {
      trail.push(seg);
      const id = await this._resolveChildFolder(parentId, seg, trail.join('/'), create);
      if (!id) return null;
      parentId = id;
    }
    return { parentId, name };
  }

  async _findFileByName(parentId, name) {
    const params = new URLSearchParams({
      ...(parentId === APP_DATA_FOLDER ? { spaces: APP_DATA_FOLDER } : {}),
      q: `name='${this._escapeQ(name)}' and '${parentId}' in parents and trashed=false`,
      fields: 'files(id,size,modifiedTime)',
      pageSize: '1',
    });
    const res = await this.apiFetch(driveFilesListURL(params));
    return (await res.json()).files?.[0] || null;
  }

  // Sniff by extension — Drive's UI picks the file icon from mimeType. PATCH
  // uses uploadType=media (content-only) so stored mimeType is preserved for
  // existing files; new POSTs get the sniffed type in their metadata.
  _mimeType(name) {
    return name.endsWith('.sqlite') ? 'application/vnd.sqlite3' : 'application/octet-stream';
  }

  // ---- BlobStore primitives ----

  async writeBlob(key, bytes) {
    const target = await this._resolveParent(key, { create: true });
    const mime = this._mimeType(target.name);
    const existing = await this._findFileByName(target.parentId, target.name);
    if (existing) {
      const res = await this.apiFetch(
        `${DRIVE_UPLOAD}/files/${existing.id}?uploadType=media&fields=size,modifiedTime`,
        { method: 'PATCH', headers: { 'Content-Type': mime }, body: bytes },
      );
      const file = await res.json();
      return { modifiedAt: new Date(file.modifiedTime), sizeBytes: Number(file.size ?? bytes.byteLength) };
    }
    const body = await this._multipartBody(
      { name: target.name, parents: [target.parentId] },
      mime, bytes,
    );
    const res = await this.apiFetch(
      driveMultipartUploadURL('uploadType=multipart&fields=size,modifiedTime'),
      { method: 'POST', body },
    );
    const file = await res.json();
    return { modifiedAt: new Date(file.modifiedTime), sizeBytes: Number(file.size ?? bytes.byteLength) };
  }

  async readBlob(key) {
    const target = await this._resolveParent(key);
    if (!target) throw new Error(`not found on Drive: ${key}`);
    const file = await this._findFileByName(target.parentId, target.name);
    if (!file) throw new Error(`not found on Drive: ${key}`);
    const res = await this.apiFetch(driveFileURL(file.id, 'alt=media'));
    return new Uint8Array(await res.arrayBuffer());
  }

  async hasBlob(key) {
    if (!this.isReady()) return false;
    try {
      const target = await this._resolveParent(key);
      if (!target) return false;
      return !!(await this._findFileByName(target.parentId, target.name));
    } catch { return false; }
  }

  async deleteBlob(key) {
    if (!this.isReady()) throw new Error('not connected');
    const target = await this._resolveParent(key);
    if (!target) return;
    const file = await this._findFileByName(target.parentId, target.name);
    if (!file) return;
    await this.apiFetch(driveFileURL(file.id), { method: 'DELETE' });
  }

  async statBlob(key) {
    if (!this.isAvailable()) return null;
    try {
      const target = await this._resolveParent(key);
      if (!target) return null;
      const file = await this._findFileByName(target.parentId, target.name);
      return file ? { modifiedAt: new Date(file.modifiedTime), sizeBytes: Number(file.size ?? 0) } : null;
    } catch { return null; }
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
