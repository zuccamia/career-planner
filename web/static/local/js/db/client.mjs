// Main-thread wrapper around the sqlite worker.
// Single global worker per tab; commands are id-tagged so multiple in-flight
// calls don't collide.

let worker = null;
let nextId = 1;
const pending = new Map();

const ensureWorker = () => {
  if (worker) return;
  worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, ok, result, error } = ev.data || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (ev) => {
    console.error('[sqlite worker error]', ev);
  };
};

// Terminate the worker eagerly when the page is unloaded, otherwise the OPFS
// SyncAccessHandles it holds may still be alive when the next page's worker
// tries to open the same pool. Disable BFCache too so we always get a fresh
// worker on return (BFCache would resurrect the old worker without re-init).
export const disposeWorker = () => {
  if (worker) {
    try { worker.terminate(); } catch {}
    worker = null;
  }
  pending.clear();
};
window.addEventListener('pagehide', disposeWorker);
window.addEventListener('beforeunload', disposeWorker);

const call = (type, extra = {}, transfer) => new Promise((resolve, reject) => {
  ensureWorker();
  const id = nextId++;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, ...extra }, transfer || []);
});

export const initDb = (dbName) => call('init', { dbName });
export const exec = async (sql, bind) => (await call('exec', { sql, bind })).rows;
export const exportDb = () => call('export');
export const importDb = (bytes) => call('import', { bytes }, [bytes.buffer]);
export const wipeDb = () => call('wipe');
