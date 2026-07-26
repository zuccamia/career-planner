// HTML component helpers for the local-first UI. All return raw HTML strings
// (the local pages compose UI via innerHTML rather than a virtual DOM).

import { escapeHtml } from './dom.mjs';
import { CLS } from './classes.mjs';
import { icon } from './icons.mjs';

// button renders a <button> or <a> styled to one of the CLS variants.
//
//   variant:   'primary' (default) | 'secondary' | 'secondaryCompact'
//              | 'danger' | 'dangerCompact' | 'linkMuted'
//   kind:      'button' (default) | 'link' — link renders <a href=...>
//   type:      submit | button (buttons only, default 'button')
//   href:      required when kind='link'
//   id:        element id
//   label:     visible text (auto-escaped)
//   icon:      icon name from ui/icons.mjs (rendered before the label)
//   iconOnly:  suppress the label span (icon-only button, needs ariaLabel)
//   ariaLabel: aria-label attribute
//   disabled:  boolean (buttons only)
//   extraClass: appended to the base variant class
//   dataset:   { key: value } → data-key="value" attributes
const BUTTON_VARIANTS = {
  primary:          CLS.btnPrimary,
  primaryCompact:   CLS.btnPrimaryCompact,
  secondary:        CLS.btnSecondary,
  secondaryCompact: CLS.btnSecondaryCompact,
  danger:           CLS.btnDanger,
  dangerCompact:    CLS.btnDangerCompact,
  icon:             CLS.btnIcon,
  iconPrimary:      CLS.btnIconPrimary,
  dangerIcon:       CLS.btnDangerIcon,
  successIcon:      CLS.btnSuccessIcon,
  linkMuted:        CLS.linkMuted,
};
export const button = ({
  variant = 'primary', kind = 'button', type, href, id, label = '',
  icon: iconName, iconOnly = false, ariaLabel, disabled = false,
  extraClass = '', dataset = {},
} = {}) => {
  const base = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary;
  const cls = `${base}${extraClass ? ' ' + extraClass : ''}`;
  const attrs = [
    id ? `id="${id}"` : '',
    ariaLabel ? `aria-label="${escapeHtml(ariaLabel)}"` : '',
    ...Object.entries(dataset).map(([k, v]) => `data-${k}="${escapeHtml(v)}"`),
  ].filter(Boolean).join(' ');
  const inner = `${iconName ? icon(iconName) : ''}${iconOnly ? '' : `<span>${escapeHtml(label)}</span>`}`;
  if (kind === 'link') {
    return `<a class="${cls}" href="${href}"${attrs ? ' ' + attrs : ''}>${inner}</a>`;
  }
  const t = type || 'button';
  const dis = disabled ? ' disabled' : '';
  return `<button class="${cls}" type="${t}"${dis}${attrs ? ' ' + attrs : ''}>${inner}</button>`;
};

// pageHeader renders the eyebrow title + tagline + optional count-line mount
// (identified by countId so pages can populate it via textContent). Defaults
// the tagline to the local-first storage note; pass tagline: null to omit.
// When countId is set, the tagline gets id `${countId}-tagline` so pages can
// hide it once data exists (see setPageCount).
const DEFAULT_TAGLINE = 'Your data lives locally in this browser.';
export const pageHeader = ({ title, tagline = DEFAULT_TAGLINE, countId = '' } = {}) => `
  <div class="space-y-2">
    <p class="${CLS.eyebrow}">${escapeHtml(title)}</p>
    ${tagline ? `<p class="text-sm text-slate-500"${countId ? ` id="${countId}-tagline"` : ''}>${escapeHtml(tagline)}</p>` : ''}
    ${countId ? `<p class="text-sm text-slate-500" id="${countId}">Loading…</p>` : ''}
  </div>
`;

// setPageCount updates the count line rendered by pageHeader and toggles the
// tagline: shown when count is 0, hidden otherwise. Pass a formatter that
// receives the count and returns the count-line text.
export const setPageCount = (countId, count, formatter) => {
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = count === 0 ? '' : formatter(count);
  const tagEl = document.getElementById(`${countId}-tagline`);
  if (tagEl) tagEl.classList.toggle('hidden', count > 0);
};

// collapsible wraps arbitrary content in a native <details> element with a
// styled toggle summary. The label swaps between `summary` (closed) and
// `openSummary` (open, default "less") — no JS needed, Tailwind's group-open
// variant handles the flip.
//
//   title:       optional bold section label that stays visible in both states.
//                When set, the swap label renders as a subtle grey hint next
//                to the title (section-header variant). When omitted, the
//                swap label alone renders as a small blue link (link variant).
//   summary:     closed-state label (escaped). Include any count in the string
//                itself, e.g. `more (${n}) …`.
//   openSummary: open-state label (escaped). Defaults to 'less'.
//   content:     inner HTML — trusted, not escaped (callers pass rendered markup).
//   extraClass:  appended to the <details> element class.
export const collapsible = ({ title = '', summary, openSummary = 'less', content = '', extraClass = '' } = {}) => {
  const wrap = `group${extraClass ? ' ' + extraClass : ''}`;
  if (title) {
    return `
      <details class="${wrap}">
        <summary class="cursor-pointer list-none text-base font-semibold text-slate-900">
          <span class="inline-flex items-center gap-2">
            <span>${escapeHtml(title)}</span>
            <span class="text-sm font-normal text-slate-500 group-open:hidden">${escapeHtml(summary)}</span>
            <span class="hidden text-sm font-normal text-slate-500 group-open:inline">${escapeHtml(openSummary)}</span>
          </span>
        </summary>
        ${content}
      </details>
    `;
  }
  return `
    <details class="${wrap}">
      <summary class="cursor-pointer list-none text-sm font-medium text-blue-700 hover:text-blue-800">
        <span class="group-open:hidden">${escapeHtml(summary)}</span>
        <span class="hidden group-open:inline">${escapeHtml(openSummary)}</span>
      </summary>
      ${content}
    </details>
  `;
};

// inlineError renders a red banner intended to live inside the surface that
// produced the failure — a form, a details panel, etc. Prefer this over a
// toast when the user's eye is already on the surface (or would have to
// scroll to see the toast). Starts hidden by default so it can sit in the
// initial render; call setInlineError(elOrId, msg) to show it later.
//
//   id:         element id (required if you plan to update via setInlineError)
//   message:    initial text; if empty, banner renders hidden
//   extraClass: appended to the base class
export const inlineError = ({ id = '', message = '', extraClass = '' } = {}) => {
  const base = 'rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700';
  const cls = `${base}${message ? '' : ' hidden'}${extraClass ? ' ' + extraClass : ''}`;
  const idAttr = id ? ` id="${id}"` : '';
  return `<p${idAttr} class="${cls}" role="alert">${escapeHtml(message)}</p>`;
};

// setInlineError updates a banner created via inlineError. Pass a falsy
// `message` to clear + hide it. Accepts either the element itself or its id.
export const setInlineError = (elOrId, message) => {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
};

// emptyState renders the shared "no data yet" box used across list panels,
// details sub-sections, and the dashboard. Callers pass id when they need to
// swap the message later without re-rendering the parent.
export const emptyState = ({ message, id = '', extraClass = '' } = {}) => {
  const cls = `rounded-2xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500${extraClass ? ' ' + extraClass : ''}`;
  const idAttr = id ? ` id="${id}"` : '';
  return `<div class="${cls}"${idAttr}>${escapeHtml(message)}</div>`;
};

// formField renders a labeled <input> / <textarea> / <select> wrapped in the
// standard grid gap-2 container.
//
//   type:        'text' (default) | 'url' | 'email' | 'number' | 'textarea' | 'select'
//   name:        required — used for both id and name
//   label:       visible label text
//   value:       current value (auto-escaped for input/textarea; ignored for select)
//   placeholder: optional placeholder
//   required:    boolean
//   rows:        textarea rows (default 3)
//   extraClass:  appended to the control's class (e.g. 'font-mono')
//   options:     [{value, label, selected}] — for type='select'
//   hint:        optional raw HTML shown as a muted note under the control
export const formField = ({
  type = 'text', name, label, value = '', placeholder = '',
  required = false, rows = 3, extraClass = '', options = [], hint = '',
}) => {
  const req = required ? ' required' : '';
  const ph = placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : '';
  const control = type === 'textarea'
    ? `<textarea id="${name}" name="${name}" rows="${rows}" class="${CLS.textarea}${extraClass ? ' ' + extraClass : ''}"${ph}${req}>${escapeHtml(value)}</textarea>`
    : type === 'select'
      ? `<select id="${name}" name="${name}"${req} class="${CLS.select}${extraClass ? ' ' + extraClass : ''}">${options.map(o =>
          `<option value="${escapeHtml(o.value)}"${o.selected ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${escapeHtml(o.label)}</option>`
        ).join('')}</select>`
      : `<input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" class="${CLS.input}${extraClass ? ' ' + extraClass : ''}"${ph}${req}>`;
  return `<div class="grid gap-2">
    <label class="${CLS.label}" for="${name}">${escapeHtml(label)}</label>
    ${control}
    ${hint ? `<p class="text-xs text-slate-500">${hint}</p>` : ''}
  </div>`;
};

// badge renders a Tailwind pill. Color must be one of the keys below; sizes
// map to 'xs' (px-2.5 py-0.5 text-xs) or 'sm' (px-3 py-1 text-sm, default).
// Class strings are literal (not template-interpolated tokens) so Tailwind's
// scanner picks them up.
const BADGE_COLORS = {
  slate:    'bg-slate-100 text-slate-700',
  blue:     'bg-blue-100 text-blue-700',
  cyan:     'bg-cyan-100 text-cyan-700',
  amber:    'bg-amber-100 text-amber-800',
  orange:   'bg-orange-100 text-orange-800',
  fuchsia:  'bg-fuchsia-100 text-fuchsia-700',
  emerald:  'bg-emerald-100 text-emerald-700',
  rose:     'bg-rose-100 text-rose-700',
  violet:   'bg-violet-100 text-violet-700',
  indigo:   'bg-indigo-100 text-indigo-700',
  red:      'bg-red-100 text-red-700',
};
const BADGE_WEIGHTS = { medium: 'font-medium', semibold: 'font-semibold' };
export const badge = ({ label, color = 'slate', size = 'sm', classes = '', icon: iconName = '', weight = 'semibold' }) => {
  const dims = size === 'xs' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  const palette = BADGE_COLORS[color] || BADGE_COLORS.slate;
  const fw = BADGE_WEIGHTS[weight] || BADGE_WEIGHTS.semibold;
  const cls = classes ? ' ' + classes : '';
  const gap = iconName ? ' gap-1' : '';
  const iconHtml = iconName ? icon(iconName, size === 'xs' ? 3 : 4) : '';
  return `<span class="inline-flex items-center${gap} rounded-full ${fw} ${dims} ${palette}${cls}">${iconHtml}${escapeHtml(label)}</span>`;
};
// badgeClasses returns just the class string, for callers that need to attach
// the palette to their own element (e.g. status pills where color depends on
// runtime state).
export const badgeClasses = (color, size = 'sm') => {
  const dims = size === 'xs' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return `inline-flex items-center rounded-full font-semibold ${dims} ${BADGE_COLORS[color] || BADGE_COLORS.slate}`;
};
