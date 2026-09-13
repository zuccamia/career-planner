// Local-disk backend using the File System Access API.
// User picks a folder once; blobs are written silently on future opens because
// we persist the FileSystemDirectoryHandle in IndexedDB.

import { idbGet, idbSet, idbDel } from './idb.mjs';
import { SNAPSHOT_SUFFIX } from './config.mjs';
import { BlobStore } from './blob_store.mjs';

const HANDLE_KEY = 'localDiskDirHandle';

export class LocalDiskBackend extends BlobStore {
  constructor() {
    super();
    this.name = 'local-disk';
    this.dirHandle = null;
  }

  static isSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  isReady() { return this.dirHandle !== null; }
  isAvailable() { return this.isReady(); }

  // Load a previously granted handle. Returns true only if permission is
  // still granted — the picker's own `id` memory (see connect()) surfaces the
  // same folder as the default on reconnect if perm has lapsed.
  async tryRestore() {
    const saved = await idbGet(HANDLE_KEY);
    if (!saved) return false;
    const perm = await saved.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    this.dirHandle = saved;
    return true;
  }

  async connect() {
    if (!LocalDiskBackend.isSupported()) {
      throw new Error('File System Access API not supported in this browser');
    }
    if (this.dirHandle) {
      const perm = await this.dirHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') return;
      this.dirHandle = null;
    }
    this.dirHandle = await window.showDirectoryPicker({
      id: 'career-planner-snapshots',
      mode: 'readwrite',
      startIn: 'documents',
    });
    await idbSet(HANDLE_KEY, this.dirHandle);
  }

  async forget() {
    this.dirHandle = null;
    await idbDel(HANDLE_KEY);
  }

  // ---- BlobStore primitives ----

  // Walk a slash-delimited key. All-but-last segments are directories.
  // With {create:true} intermediates are auto-created; otherwise a missing
  // segment throws NotFoundError (which primitives translate as appropriate).
  async _resolveFileHandle(key, { create = false } = {}) {
    if (!this.isReady()) throw new Error('not connected');
    const parts = key.split('/');
    const filename = parts.pop();
    let dir = this.dirHandle;
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir.getFileHandle(filename, { create });
  }

  // Same as above but returns [parentDir, filename] for delete's removeEntry.
  async _resolveParent(key) {
    if (!this.isReady()) throw new Error('not connected');
    const parts = key.split('/');
    const filename = parts.pop();
    let dir = this.dirHandle;
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg);
    }
    return [dir, filename];
  }

  async writeBlob(key, bytes) {
    const fh = await this._resolveFileHandle(key, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    const file = await fh.getFile();
    return { modifiedAt: new Date(file.lastModified), sizeBytes: file.size };
  }

  async readBlob(key) {
    const fh = await this._resolveFileHandle(key);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async hasBlob(key) {
    if (!this.isReady()) return false;
    try { await this._resolveFileHandle(key); return true; }
    catch { return false; }
  }

  async deleteBlob(key) {
    if (!this.isReady()) throw new Error('not connected');
    try {
      const [dir, filename] = await this._resolveParent(key);
      await dir.removeEntry(filename);
    } catch (err) {
      if (err && err.name === 'NotFoundError') return;
      throw err;
    }
  }

  async statBlob(key) {
    if (!this.isReady()) return null;
    try {
      const fh = await this._resolveFileHandle(key);
      const file = await fh.getFile();
      return { modifiedAt: new Date(file.lastModified), sizeBytes: file.size };
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  // ---- snapshot list UI helpers (root-level .sqlite files only) ----

  async listSnapshots() {
    if (!this.isReady()) throw new Error('not connected');
    const results = [];
    for await (const [name, handle] of this.dirHandle.entries()) {
      if (handle.kind !== 'file' || !name.endsWith(SNAPSHOT_SUFFIX)) continue;
      const file = await handle.getFile();
      results.push({ id: name, name, createdAt: new Date(file.lastModified), sizeBytes: file.size });
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results;
  }

  async loadSnapshot(id) { return this.readBlob(id); }
  async deleteSnapshot(id) { return this.deleteBlob(id); }
}
