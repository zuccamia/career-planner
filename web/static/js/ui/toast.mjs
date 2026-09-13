// Shared toast helper. Expects a <div id="toast"> mount point in the page
// shell. Toasts stay visible until the user clicks the close button.

import { escapeHtml } from './dom.mjs';
import { icon } from './icons.mjs';

const STYLES = {
  ok:      'border-status-win/40 bg-status-win-bg text-status-win',
  error:   'border-status-out/30 bg-status-out-bg text-status-out',
  warning: 'border-brass/30 bg-brass-tint text-brass',
  info:    'border-line-strong bg-surface text-ink-soft shadow-sm',
};

const CLS = {
  container: 'flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm',
  message:   'min-w-0 flex-1',
  details:   'mt-2 list-disc space-y-0.5 pl-4 text-xs opacity-80',
  action:    'mt-2 inline-flex items-center gap-1 rounded-full border border-current px-3 py-1 text-xs font-semibold opacity-80 transition hover:opacity-100',
  close:     'js-toast-close shrink-0 rounded-full p-1 opacity-70 transition hover:bg-black/5 hover:opacity-100',
};

export const toast = (msg, kind = 'info', { details, action } = {}) => {
  const el = document.getElementById('toast');
  if (!el) return;
  el.className = `${CLS.container} ${STYLES[kind] || STYLES.info}`;
  const detailsHtml = Array.isArray(details) && details.length
    ? `<ul class="${CLS.details}">${details.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
    : '';
  const actionHtml = action
    ? `<button type="button" class="js-toast-action ${CLS.action}">${escapeHtml(action.label)}</button>`
    : '';
  el.innerHTML = `
    <span class="${CLS.message}">${escapeHtml(msg)}${detailsHtml}${actionHtml}</span>
    <button type="button" class="${CLS.close}" aria-label="Dismiss">
      ${icon('close')}
    </button>
  `;
  el.classList.remove('hidden');
  const dismiss = () => el.classList.add('hidden');
  el.querySelector('.js-toast-close').addEventListener('click', dismiss);
  if (action) {
    el.querySelector('.js-toast-action').addEventListener('click', async () => {
      try { await action.onClick({ dismiss }); }
      catch (err) { console.error('toast action failed:', err); }
    });
  }
};
