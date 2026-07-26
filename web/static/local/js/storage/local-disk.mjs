// Local-disk backend using the File System Access API.
// User picks a folder once; snapshots and attachments are written silently on
// future opens because we persist the FileSystemDirectoryHandle in IndexedDB.

import { idbGet, idbSet, idbDel } from './idb.mjs';
import { snapshotFilename, SNAPSHOT_PREFIX, SNAPSHOT_SUFFIX } from './config.mjs';

const HANDLE_KEY = 'localDiskDirHandle';

export class LocalDiskBackend {
  constructor() {
    this.name = 'local-disk';
    this.dirHandle = null;
  }

  static isSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  isReady() { return this.dirHandle !== null; }
  isAvailable() { return this.isReady(); }

  // Load a previously granted handle. Returns true only if permission is
  // still granted (no prompt needed). If permission has lapsed we leave
  // dirHandle null so isReady() stays honest — the picker's own `id` memory
  // (see connect()) surfaces the same folder as the default on reconnect.
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

  async saveSnapshot(bytes, { label = '' } = {}) {
    if (!this.isReady()) throw new Error('not connected');
    const createdAt = new Date();
    const id = snapshotFilename(createdAt, label);
    const fh = await this.dirHandle.getFileHandle(id, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return { id, name: id, createdAt, sizeBytes: bytes.byteLength };
  }

  async listSnapshots() {
    if (!this.isReady()) throw new Error('not connected');
    const results = [];
    for await (const [name, handle] of this.dirHandle.entries()) {
      if (handle.kind !== 'file' || !name.startsWith(SNAPSHOT_PREFIX) || !name.endsWith(SNAPSHOT_SUFFIX)) continue;
      const file = await handle.getFile();
      results.push({ id: name, name, createdAt: new Date(file.lastModified), sizeBytes: file.size });
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results;
  }

  async loadSnapshot(id) {
    if (!this.isReady()) throw new Error('not connected');
    const fh = await this.dirHandle.getFileHandle(id);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async deleteSnapshot(id) {
    if (!this.isReady()) throw new Error('not connected');
    await this.dirHandle.removeEntry(id);
  }

  async _entityDir(folder) {
    const root = await this.dirHandle.getDirectoryHandle('attachments', { create: true });
    return root.getDirectoryHandle(folder, { create: true });
  }

  async hasAttachment(folder, filename) {
    if (!this.isReady()) return false;
    try {
      const dir = await this._entityDir(folder);
      await dir.getFileHandle(filename);
      return true;
    } catch { return false; }
  }

  async saveAttachment(folder, filename, bytes) {
    if (!this.isReady()) throw new Error('not connected');
    const dir = await this._entityDir(folder);
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return { storedFilename: filename, sizeBytes: bytes.byteLength };
  }

  async loadAttachment(folder, filename) {
    if (!this.isReady()) throw new Error('not connected');
    const dir = await this._entityDir(folder);
    const fh = await dir.getFileHandle(filename);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }
}
