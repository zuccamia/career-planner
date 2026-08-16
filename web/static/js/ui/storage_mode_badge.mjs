// Renders the "Storage" pill in the sidebar. Four states, click → Settings:
//   - Drive + Local disk  → slate  "Drive + Local"
//   - Drive only          → slate  "Google Drive"
//   - Local disk only     → slate  "Local disk"
//   - Neither             → amber  "Storage: setup needed"
// Neither = user is browser-only (SQLite lives in OPFS, but snapshots and
// attachments have nowhere to sync/persist across devices).

import { localDisk, googleDrive } from '../storage/index.mjs';
import { badge } from './components.mjs';
import { t } from '../i18n.mjs';

export const refreshStorageModeBadge = async () => {
  const wrap = document.getElementById('storage-mode-badge');
  if (!wrap) return;
  const hasDrive = googleDrive.isReady();
  const hasLocal = localDisk.isReady();

  let label, color;
  if (hasDrive && hasLocal) {
    color = 'slate';
    label = t('settings.storage.badge.drive_and_local');
  } else if (hasDrive) {
    color = 'slate';
    label = t('settings.storage.badge.drive');
  } else if (hasLocal) {
    color = 'slate';
    label = t('settings.storage.badge.local');
  } else {
    color = 'amber';
    label = t('settings.storage.badge.setup_needed');
  }

  wrap.innerHTML = badge({ color, size: 'xs', icon: 'folder', label });
  wrap.classList.remove('hidden');
};
