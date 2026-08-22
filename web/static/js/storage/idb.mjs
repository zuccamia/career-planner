// Tiny IndexedDB kv wrapper used to persist backend metadata
// (FileSystemDirectoryHandle, Google refresh token, cached folder ids).

const IDB_NAME = 'career-planner-meta';
const IDB_STORE = 'kv';

const openMetaDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
  req.onsuccess = () => {
    const db = req.result;
    // Close on demand so a concurrent deleteDatabase (idbWipe here, or a
    // wipe in another tab) doesn't hit onblocked while this connection
    // finishes releasing.
    db.onversionchange = () => db.close();
    resolve(db);
  };
  req.onerror = () => reject(req.error);
});

// Helpers close their connection after each call so idbWipe's deleteDatabase
// doesn't see a live handle from this tab and fire onblocked.
export const idbGet = async (key) => {
  const db = await openMetaDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      // Wait for tx.oncomplete (not req.onsuccess) so db.close() below runs
      // after the tx has fully committed. Prevents idbWipe onblocked races.
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
};

export const idbSet = async (key, value) => {
  const db = await openMetaDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
};

// Delete the entire meta database (used by the wipe-all-data action).
// `onblocked` is informational, not terminal: the delete keeps waiting while
// open connections release. Our openMetaDb sets versionchange → close, so a
// blocked delete typically resolves on its own once the pending tx settles.
// Callers wrap in a timeout if they need a hard give-up (see settings.mjs).
export const idbWipe = () => new Promise((resolve, reject) => {
  const req = indexedDB.deleteDatabase(IDB_NAME);
  req.onsuccess = () => resolve();
  req.onerror = () => reject(req.error);
  req.onblocked = () => console.warn('idbWipe: waiting for open connections to release (onblocked)');
});

export const idbDel = async (key) => {
  const db = await openMetaDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
};
