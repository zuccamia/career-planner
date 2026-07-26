// sqlite-wasm worker running in a Web Worker context.
// Installs OPFS SAH Pool VFS explicitly (the built-in worker1 protocol does
// not), then dispatches simple {id, type, ...} messages from the main thread.
import sqlite3InitModule from 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.50.1-build1/sqlite-wasm/jswasm/sqlite3.mjs';

// Storage identifier for the OPFS SAH pool. Renaming this forks storage:
// the old pool becomes orphaned (reachable only via DevTools). Only change
// when you're prepared to abandon or migrate existing browser-local data.
const POOL_NAME = 'career-planner-local-pool';
const DEFAULT_DB = '/career-planner.sqlite';

let sqlite3 = null;
let poolUtil = null;
let db = null;
let dbFilename = null;

const send = (id, ok, payload, transfer) => {
  self.postMessage(
    { id, ok, ...(ok ? { result: payload } : { error: payload }) },
    transfer || [],
  );
};

const errStr = (e) => (e && (e.message || e.reason)) || String(e);

const openDb = (name) => {
  if (db) db.close();
  db = new poolUtil.OpfsSAHPoolDb(name);
  dbFilename = db.filename;
};

self.onmessage = async (ev) => {
  const { id, type, sql, bind, dbName, bytes } = ev.data || {};
  try {
    if (type === 'init') {
      if (!sqlite3) {
        sqlite3 = await sqlite3InitModule();
        if (!sqlite3.installOpfsSAHPoolVfs) {
          throw new Error('installOpfsSAHPoolVfs missing — sqlite-wasm build lacks OPFS SAH Pool support');
        }
        poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
      }
      openDb(dbName || DEFAULT_DB);
      send(id, true, {
        version: sqlite3.version.libVersion,
        filename: dbFilename,
        vfs: 'opfs-sahpool',
        poolCapacity: poolUtil.getCapacity(),
        poolUsed: poolUtil.getFileCount(),
      });
      return;
    }

    if (!db) throw new Error('DB not initialized');

    if (type === 'exec') {
      const rows = [];
      db.exec({ sql, bind, rowMode: 'object', resultRows: rows });
      send(id, true, { rows });
      return;
    }

    if (type === 'export') {
      const out = sqlite3.capi.sqlite3_js_db_export(db.pointer);
      send(id, true, { bytes: out, filename: dbFilename }, [out.buffer]);
      return;
    }

    if (type === 'import') {
      if (!(bytes instanceof Uint8Array)) throw new Error('import requires Uint8Array bytes');
      const name = dbFilename;
      db.close();
      db = null;
      await poolUtil.importDb(name, bytes);
      openDb(name);
      send(id, true, { filename: dbFilename, sizeBytes: bytes.byteLength });
      return;
    }

    if (type === 'wipe') {
      if (db) { db.close(); db = null; }
      const removed = await poolUtil.wipeFiles();
      send(id, true, { removed });
      return;
    }

    throw new Error(`unknown message type: ${type}`);
  } catch (err) {
    send(id, false, errStr(err));
  }
};
