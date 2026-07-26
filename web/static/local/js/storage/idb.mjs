// Tiny IndexedDB kv wrapper used to persist backend metadata
// (FileSystemDirectoryHandle, Google refresh token, cached folder ids).

const IDB_NAME = 'career-planner-meta';
const IDB_STORE = 'kv';

const openMetaDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const idbGet = async (key) => {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

export const idbSet = async (key, value) => {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// Delete the entire meta database (used by the wipe-all-data action).
export const idbWipe = () => new Promise((resolve, reject) => {
  const req = indexedDB.deleteDatabase(IDB_NAME);
  req.onsuccess = () => resolve();
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(new Error('deleteDatabase blocked — close other tabs'));
});

export const idbDel = async (key) => {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};
