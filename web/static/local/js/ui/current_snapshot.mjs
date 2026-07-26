// Renders the "current snapshot" badge in the sidebar. Reads the name from
// IndexedDB via the storage/current-snapshot helper and formats it.

import { getCurrentSnapshotName, formatSnapshotName } from '../storage/current-snapshot.mjs';

export const refreshCurrentSnapshotBadge = async () => {
  const wrap = document.getElementById('current-snapshot');
  const nameEl = document.getElementById('current-snapshot-name');
  if (!wrap || !nameEl) return;
  try {
    const name = await getCurrentSnapshotName();
    if (!name) {
      wrap.classList.add('hidden');
      nameEl.textContent = '';
      nameEl.title = '';
      return;
    }
    nameEl.textContent = formatSnapshotName(name);
    nameEl.title = name;
    wrap.classList.remove('hidden');
  } catch (err) {
    console.warn('[local] current snapshot badge', err);
  }
};
