// Shared open/close for right slide-overs and the left mobile drawer.
// Runs the accessibility choreography — backdrop, Esc, outside-click, focus
// trap, body-scroll lock, return focus — around a panel whose show/hide
// styling is owned by the caller (a class toggle, typically a transform).
//
// Usage:
//   const close = openOverlay({
//     panel: sidebarEl,
//     trigger: hamburgerButton,
//     onOpen: () => sidebarEl.classList.add('translate-x-0'),
//     onClose: () => sidebarEl.classList.remove('translate-x-0'),
//   });
//   // …later
//   close();
//
// Multiple overlays can stack; the backdrop hides only when the last one closes.

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack = [];
let backdropEl = null;
let prevFocus = null;

const ensureBackdrop = () => {
  if (backdropEl) return backdropEl;
  backdropEl = document.createElement('div');
  backdropEl.id = 'overlay-backdrop';
  backdropEl.className = 'fixed inset-0 z-40 hidden bg-ink/50';
  backdropEl.addEventListener('click', () => {
    const top = stack[stack.length - 1];
    if (top) top.close();
  });
  document.body.appendChild(backdropEl);
  return backdropEl;
};

const onKey = (e) => {
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  if (e.key === 'Escape') {
    e.preventDefault();
    top.close();
    return;
  }
  if (e.key === 'Tab') {
    const fs = top.panel.querySelectorAll(FOCUSABLE);
    if (!fs.length) return;
    const first = fs[0];
    const last = fs[fs.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
};

export const openOverlay = ({ panel, trigger, onOpen, onClose } = {}) => {
  if (!panel) return () => {};
  const backdrop = ensureBackdrop();
  const entry = { panel, trigger, onClose, close: null };

  const close = () => {
    const idx = stack.indexOf(entry);
    if (idx === -1) return;
    stack.splice(idx, 1);
    if (onClose) onClose();
    if (!stack.length) {
      backdrop.classList.add('hidden');
      document.body.classList.remove('overflow-hidden');
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      prevFocus = null;
    } else if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  };
  entry.close = close;

  if (!stack.length) {
    prevFocus = document.activeElement;
    document.body.classList.add('overflow-hidden');
    backdrop.classList.remove('hidden');
    document.addEventListener('keydown', onKey);
  }
  stack.push(entry);
  if (onOpen) onOpen();

  const fs = panel.querySelectorAll(FOCUSABLE);
  if (fs.length) fs[0].focus();

  if (trigger) trigger.setAttribute('aria-expanded', 'true');

  return () => {
    close();
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  };
};
