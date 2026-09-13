// Header sync button. Uses the active label (no switching from here); success
// flashes a green check on the button, errors surface as toasts.

import {
  syncCurrentSnapshot, getActiveSyncLabel, finalizeSyncResult, getLastSyncedAt,
  getDivergenceState,
} from '../storage/sync-current.mjs';
import { availableBackends } from '../storage/index.mjs';
import { activeSyncFilename } from '../storage/config.mjs';
import { STATIC_ROOT } from '../host.mjs';
import { toast } from './toast.mjs';
import { icon } from './icons.mjs';
import { CLS } from './classes.mjs';
import { relativeAge } from './format.mjs';
import { t } from '../i18n.mjs';

// Middle-truncate so the extension stays visible: "summer2026.sqlite" → "summer….sqlite".
const truncateFilename = (name, max = 14) => {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.slice(0, max - 1) + '…';
  const ext = name.slice(dot);
  const stem = name.slice(0, dot);
  const keep = Math.max(1, max - ext.length - 1);
  return stem.slice(0, keep) + '…' + ext;
};

const paintLabel = async () => {
  const el = document.getElementById('quick-sync-label');
  if (!el) return;
  const [label, syncedAt] = await Promise.all([getActiveSyncLabel(), getLastSyncedAt()]);
  const filename = activeSyncFilename(label);
  el.textContent = truncateFilename(filename);
  el.title = syncedAt
    ? t('nav.quick_sync.tooltip_with_age', { file: filename, age: relativeAge(new Date(syncedAt).toISOString()) })
    : filename;
  CLS.metaText.split(' ').forEach(c => el.classList.add(c));
  el.classList.remove('hidden');
};

// Palette only — layout stays on the button from $hdrBtn. Keep idle in sync with it.
const IDLE_PALETTE = 'border-line-strong bg-surface text-ink-soft hover:border-brand hover:bg-brand-tint';
const SUCCESS_PALETTE = 'border-status-win/30 bg-status-win-bg text-status-win';
const WARNING_PALETTE = 'border-brass/30 bg-brass-tint text-brass hover:bg-brass-tint';
const SUCCESS_HOLD_MS = 1500;

const setIcon = (wrap, name, { spin = false } = {}) => {
  if (!wrap) return;
  wrap.innerHTML = icon(name);
  wrap.classList.toggle('animate-spin', spin);
};

const setButtonStyle = (btn, kind) => {
  IDLE_PALETTE.split(' ').forEach(c => btn.classList.toggle(c, kind === 'idle'));
  SUCCESS_PALETTE.split(' ').forEach(c => btn.classList.toggle(c, kind === 'success'));
  WARNING_PALETTE.split(' ').forEach(c => btn.classList.toggle(c, kind === 'warning'));
};

const paintDivergenceState = async (btn, iconWrap) => {
  const state = await getDivergenceState();
  if (state) {
    setIcon(iconWrap, 'exclamationTriangle');
    setButtonStyle(btn, 'warning');
    btn.title = t('nav.quick_sync.title_divergent');
    return true;
  }
  return false;
};

export const mountQuickSync = async () => {
  const btn = document.getElementById('quick-sync');
  if (!btn) return;
  const iconWrap = document.getElementById('quick-sync-icon');
  const repaint = async () => {
    if (!(await paintDivergenceState(btn, iconWrap))) {
      setIcon(iconWrap, 'arrowPath');
      setButtonStyle(btn, 'idle');
      btn.title = t('nav.quick_sync.title');
    }
    paintLabel();
  };
  await repaint();
  window.addEventListener('divergence-detected', repaint);
  window.addEventListener('divergence-resolved', repaint);

  let resetTimer = null;

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    // In a divergent state, clicking navigates to Settings instead of firing
    // sync — the resolution UI lives there.
    if (await getDivergenceState()) {
      location.href = `${STATIC_ROOT}settings#sync-panel`;
      return;
    }
    if (availableBackends().length === 0) {
      toast(t('nav.quick_sync.error.no_backends'), 'warning');
      return;
    }
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    btn.disabled = true;
    setButtonStyle(btn, 'idle');
    setIcon(iconWrap, 'arrowPath', { spin: true });
    let flashedSuccess = false;
    try {
      const label = await getActiveSyncLabel();
      const result = await syncCurrentSnapshot({ label });
      if (result.skipped === 'no_backends') {
        toast(t('nav.quick_sync.error.no_backends'), 'warning');
        return;
      }
      if (result.skipped === 'divergence') {
        // The 'divergence-detected' event repaints via the listener above.
        toast(t('nav.quick_sync.toast.divergent'), 'warning');
        return;
      }
      const { errors, winner } = finalizeSyncResult(result);
      if (errors.length === 0) {
        flashedSuccess = true;
        setIcon(iconWrap, 'check');
        setButtonStyle(btn, 'success');
        resetTimer = setTimeout(() => {
          setIcon(iconWrap, 'arrowPath');
          setButtonStyle(btn, 'idle');
          resetTimer = null;
        }, SUCCESS_HOLD_MS);
      } else {
        console.warn('quick-sync errors:', errors);
        toast(t('nav.quick_sync.toast.partial', { winner, n: errors.length }), 'info');
      }
    } catch (err) {
      console.error('quick-sync failed:', err);
      toast(t('nav.quick_sync.error.failed', { err: err.message }), 'error');
    } finally {
      btn.disabled = false;
      if (!flashedSuccess) setIcon(iconWrap, 'arrowPath');
      paintLabel();
    }
  });
};
