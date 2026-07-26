// Shared toast helper. Expects a <div id="toast"> mount point in the page
// shell. Toasts stay visible until the user clicks the close button.

import { escapeHtml } from './dom.mjs';
import { icon } from './icons.mjs';

const STYLES = {
  ok:      'border-emerald-300 bg-emerald-50 text-emerald-900',
  error:   'border-red-200 bg-red-50 text-red-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  info:    'border-slate-200 bg-slate-50 text-slate-700',
};

export const toast = (msg, kind = 'info') => {
  const el = document.getElementById('toast');
  if (!el) return;
  el.className = `flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm ${STYLES[kind] || STYLES.info}`;
  el.innerHTML = `
    <span class="min-w-0 flex-1">${escapeHtml(msg)}</span>
    <button type="button" class="js-toast-close shrink-0 rounded-full p-1 opacity-70 transition hover:bg-black/5 hover:opacity-100" aria-label="Dismiss">
      ${icon('close')}
    </button>
  `;
  el.classList.remove('hidden');
  el.querySelector('.js-toast-close').addEventListener('click', () => {
    el.classList.add('hidden');
  });
};
