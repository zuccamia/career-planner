// Right-hand slide-over. Moves an existing page panel into a fixed overlay
// while open; on close, puts it back with its original className.

import { openOverlay } from './overlay.mjs';
import { CLS } from './classes.mjs';

const CLOSED = 'translate-x-full';
const OPEN = 'translate-x-0';

const state = new Map();

const restore = (panelId) => {
  const rec = state.get(panelId);
  if (!rec) return;
  const panel = document.getElementById(panelId);
  if (panel && rec.anchor && rec.anchor.parentNode) {
    rec.anchor.parentNode.insertBefore(panel, rec.anchor);
    rec.anchor.remove();
  }
  if (panel) panel.className = rec.originalClass;
  state.delete(panelId);
};

export const openSlideOver = ({ panelId, trigger, onClose } = {}) => {
  const panel = document.getElementById(panelId);
  if (!panel) return () => {};
  if (state.has(panelId)) return state.get(panelId).close;

  const originalClass = panel.className;
  const anchor = document.createComment(`slide-over-anchor:${panelId}`);
  panel.parentNode.insertBefore(anchor, panel);
  document.body.appendChild(panel);
  panel.className = `${CLS.slideOverPanel} ${CLOSED}`;
  panel.classList.remove('hidden');
  requestAnimationFrame(() => panel.classList.replace(CLOSED, OPEN));

  const close = openOverlay({
    panel,
    trigger,
    onClose: () => {
      panel.classList.replace(OPEN, CLOSED);
      const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
      setTimeout(() => {
        restore(panelId);
        panel.innerHTML = '';
        panel.classList.add('hidden');
        if (onClose) onClose();
      }, delay);
    },
  });
  state.set(panelId, { originalClass, anchor, close });
  return close;
};

export const closeSlideOver = (panelId) => {
  const rec = state.get(panelId);
  if (rec) rec.close();
};

export const isSlideOverOpen = (panelId) => state.has(panelId);
