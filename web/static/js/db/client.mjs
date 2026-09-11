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

// Graceful shutdown (worker calls db.close + pauseVfs + self.close). The
// next page's initDb retries on SAH-lock so a slow release doesn't surface
// as a user error. `beforeunload` disables BFCache so return-visits re-init.
export const disposeWorker = () => {
  if (worker) {
    try { worker.postMessage({ type: 'shutdown' }); } catch {}
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

// Retry SAH-lock failures so the old page's async worker shutdown doesn't
// race the new page's init. Also retry when the worker never responds
// (hung mid-acquire), since Chromium's OPFS cleanup can pause the worker
// without throwing. Two-tab collisions exhaust the retries and throw.
const isSAHLockError = (err) => {
  const msg = err?.message || String(err);
  return msg.includes('another open Access Handle') || msg.includes('Access Handles cannot be created');
};
export const initDb = async (dbName) => {
  const attempts = 6;
  const delayMs = 400;
  const perAttemptTimeoutMs = 3000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await Promise.race([
        call('init', { dbName }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('init timeout')), perAttemptTimeoutMs)),
      ]);
    } catch (err) {
      const retriable = isSAHLockError(err) || err.message === 'init timeout';
      if (!retriable || i === attempts - 1) throw err;
      try { worker?.terminate(); } catch {}
      worker = null;
      pending.clear();
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
};
export const exec = async (sql, bind) => (await call('exec', { sql, bind })).rows;
export const exportDb = () => call('export');
export const importDb = (bytes) => call('import', { bytes }, [bytes.buffer]);
export const wipeDb = () => call('wipe');

// decodeJSON parses a TEXT-JSON column value with a fallback for null / empty
// / malformed input. Returned by reference — pass fresh values from the call
// site if you need independent copies per row.
export const decodeJSON = (raw, fallback) => {
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch { return fallback; }
};

// Runs `fn` inside a SQLite transaction. Commits on success, rolls back on
// throw. Single-writer (one worker per tab, OPFS holds an exclusive lock),
// so BEGIN is safe. Nesting is not supported — SQLite will throw "cannot
// start a transaction within a transaction" if called re-entrantly.
let inTx = false;
export const transaction = async (fn) => {
  if (inTx) throw new Error('transaction: nesting not supported');
  inTx = true;
  await call('exec', { sql: 'BEGIN' });
  try {
    const result = await fn();
    await call('exec', { sql: 'COMMIT' });
    return result;
  } catch (err) {
    try { await call('exec', { sql: 'ROLLBACK' }); } catch {}
    throw err;
  } finally {
    inTx = false;
  }
};
