// HTML component helpers for the UI. All return raw HTML strings
// (the local pages compose UI via innerHTML rather than a virtual DOM).

import { escapeHtml } from './dom.mjs';
import { CLS } from './classes.mjs';
import { icon } from './icons.mjs';
import { t } from '../i18n.mjs';

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
// the tagline to the default storage note; pass tagline: null to omit.
// When countId is set, the tagline gets id `${countId}-tagline` so pages can
// hide it once data exists (see setPageCount).
// Callers can pass an explicit tagline string, or pass `null` to omit. When
// undefined, the default "data lives locally" note is used — resolved at call
// time so the current locale wins.
export const pageHeader = ({ title, tagline, countId = '' } = {}) => {
  const line = tagline === undefined ? t('common.page_tagline') : tagline;
  return `
  <div class="space-y-2">
    <p class="${CLS.eyebrow}">${escapeHtml(title)}</p>
    ${line ? `<p class="text-sm text-slate-500"${countId ? ` id="${countId}-tagline"` : ''}>${escapeHtml(line)}</p>` : ''}
    ${countId ? `<p class="text-sm text-slate-500" id="${countId}">${t('app.loading')}</p>` : ''}
  </div>
`;
};

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

// inlineNote is the success/info sibling of inlineError — a persistent inline
// banner for messages that are too long for a toast (e.g. LLM reasoning after
// a successful build/extract). Same show/hide API as setInlineError.
export const inlineNote = ({ id = '', message = '', extraClass = '' } = {}) => {
  const base = 'rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800';
  const cls = `${base}${message ? '' : ' hidden'}${extraClass ? ' ' + extraClass : ''}`;
  const idAttr = id ? ` id="${id}"` : '';
  return `<p${idAttr} class="${cls}" role="status">${escapeHtml(message)}</p>`;
};

export const setInlineNote = (elOrId, message) => {
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

// inlineWarning mirrors the warning toast palette for persistent inline alerts.
export const inlineWarning = ({ id = '', message = '', extraClass = '' } = {}) => {
  const base = 'rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800';
  const cls = `${base}${message ? '' : ' hidden'}${extraClass ? ' ' + extraClass : ''}`;
  const idAttr = id ? ` id="${id}"` : '';
  return `<p${idAttr} class="${cls}" role="status">${escapeHtml(message)}</p>`;
};

export const setInlineWarning = (elOrId, message) => {
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
//   type:        'text' (default) | 'url' | 'email' | 'number' | 'date' |
//                'textarea' | 'select' — anything unrecognized is passed
//                through as the input type attribute.
//   name:        required — used for both id and name
//   label:       visible label text
//   value:       current value (auto-escaped for input/textarea; ignored for select)
//   placeholder: optional placeholder
//   required:    boolean
//   rows:        textarea rows (default 3)
//   extraClass:  appended to the control's class (e.g. 'font-mono')
//   options:     [{value, label, selected, disabled}] — for type='select'
//   hint:        optional raw HTML shown as a muted note under the control
//   dataset:     { key: value } → data-* attributes on the input/textarea/select
export const formField = ({
  type = 'text', name, label, value = '', placeholder = '',
  required = false, rows = 3, extraClass = '', options = [], hint = '',
  min = '', max = '', step = '',
  dataset = {},
}) => {
  const req = required ? ' required' : '';
  const ph = placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : '';
  const minAttr = min !== '' ? ` min="${escapeHtml(min)}"` : '';
  const maxAttr = max !== '' ? ` max="${escapeHtml(max)}"` : '';
  const stepAttr = step !== '' ? ` step="${escapeHtml(step)}"` : '';
  const dataAttrs = Object.entries(dataset)
    .map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`)
    .join('');
  const control = type === 'textarea'
    ? `<textarea id="${name}" name="${name}" rows="${rows}" class="${CLS.textarea}${extraClass ? ' ' + extraClass : ''}"${ph}${req}${dataAttrs}>${escapeHtml(value)}</textarea>`
    : type === 'select'
      ? `<select id="${name}" name="${name}"${req} class="${CLS.select}${extraClass ? ' ' + extraClass : ''}"${dataAttrs}>${options.map(o =>
          `<option value="${escapeHtml(o.value)}"${o.selected ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${escapeHtml(o.label)}</option>`
        ).join('')}</select>`
      : `<input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" class="${CLS.input}${extraClass ? ' ' + extraClass : ''}"${ph}${req}${minAttr}${maxAttr}${stepAttr}${dataAttrs}>`;
  return `<div class="grid gap-2">
    <label class="${CLS.label}" for="${name}">${escapeHtml(label)}</label>
    ${control}
    ${hint ? `<p class="text-xs text-slate-500">${hint}</p>` : ''}
  </div>`;
};

// pillDismiss renders the tiny × dismiss button that lives inside a badge()'s
// `body` — the "delete this pill" affordance. Sized to sit comfortably inside
// a size='sm' badge; hover styling suggests destructive intent.
//
//   dataset:    { key: value } → data-* attributes
//   extraClass: appended to the base class (typically a js-* selector hook)
//   ariaLabel:  screen-reader label (default "Remove")
export const pillDismiss = ({ dataset = {}, extraClass = '', ariaLabel = 'Remove' } = {}) => {
  const attrs = Object.entries(dataset)
    .map(([k, v]) => `data-${k}="${escapeHtml(v)}"`)
    .join(' ');
  const base = 'inline-flex h-5 w-5 items-center justify-center rounded-full opacity-60 hover:bg-red-50 hover:text-red-600 hover:opacity-100';
  const cls = `${base}${extraClass ? ' ' + extraClass : ''}`;
  return `<button type="button" class="${cls}"${attrs ? ' ' + attrs : ''} aria-label="${escapeHtml(ariaLabel)}">×</button>`;
};

// removablePill renders a badge-styled pill with a text label and embedded
// dismiss button. It composes badge() + pillDismiss() so pages can share the
// same visual treatment for skills, sparks, brag tags, and similar tokens.
export const removablePill = ({
  label,
  bodyHtml = '',
  color = 'slate',
  classes = 'gap-1.5',
  dataset = {},
  dismissClass = '',
  dismissLabel = 'Remove',
} = {}) => badge({
  color,
  classes,
  dataset,
  body:
    `<span>${bodyHtml || escapeHtml(label)}</span>`
    + pillDismiss({ dataset, extraClass: dismissClass, ariaLabel: dismissLabel }),
});

// tab renders a single button in a tab strip. Active tab gets an underline
// and colored text; inactive is muted and hover-underlines. The caller wires
// clicks via data-tab / .js-tab selector.
//
// An empty count slot is always rendered (initially hidden) so callers can
// populate it later without re-rendering the tab — same pattern the sidebar
// uses. Look up the slot via `[data-tab-count="<name>"]` and set textContent
// + toggle .hidden.
//
//   label:   visible text (escaped)
//   name:    data-tab value (escaped)
//   active:  boolean — apply the active styling
export const tab = ({ label, name, active = false } = {}) => {
  const state = active
    ? 'border-b-2 border-blue-600 text-blue-700'
    : 'border-b-2 border-transparent text-slate-500 hover:text-slate-900';
  return `<button type="button" class="js-tab inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold transition ${state}" data-tab="${escapeHtml(name)}" role="tab" aria-selected="${active}">${escapeHtml(label)}<span data-tab-count="${escapeHtml(name)}" class="hidden rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-700"></span></button>`;
};

// chip renders a small outline pill button — used for suggestion chips
// (wizard "add spark by clicking a suggestion") and similar affordances.
// Class .js-chip is the selector convention; dataset carries the payload.
//
//   label:   visible text (escaped); rendered with a leading "+ " prefix
//   dataset: { key: value } → data-* attrs
//   noPrefix: skip the "+ " prefix (default false)
export const chip = ({ label, dataset = {}, noPrefix = false } = {}) => {
  const attrs = Object.entries(dataset)
    .map(([k, v]) => `data-${k}="${escapeHtml(v)}"`)
    .join(' ');
  const prefix = noPrefix ? '' : '+ ';
  return `<button type="button" class="js-chip inline-flex items-center rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:border-blue-400 hover:bg-blue-50"${attrs ? ' ' + attrs : ''}>${escapeHtml(prefix + label)}</button>`;
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
// badge props:
//   label:     visible text (escaped). Ignored when `body` is supplied.
//   color:     one of BADGE_COLORS keys
//   size:      'xs' | 'sm'
//   classes:   appended to the outer <span>
//   icon:      icon name (see ui/icons.mjs). Ignored when `body` is supplied.
//   weight:    'medium' | 'semibold'
//   body:      optional raw HTML that replaces the icon+label content —
//              for interactive pills (e.g. spark pills with inline edit/
//              delete buttons). Callers own the escaping of anything inside.
//   dataset:   optional { key: value } for data-* attrs on the outer span
//   id:        optional element id
export const badge = ({
  label, color = 'slate', size = 'sm', classes = '', icon: iconName = '', weight = 'semibold',
  body = '', dataset = {}, id = '',
} = {}) => {
  const dims = size === 'xs' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  const palette = BADGE_COLORS[color] || BADGE_COLORS.slate;
  const fw = BADGE_WEIGHTS[weight] || BADGE_WEIGHTS.semibold;
  const cls = classes ? ' ' + classes : '';
  const useBody = Boolean(body);
  const gap = (iconName && !useBody) ? ' gap-1' : '';
  const iconHtml = (iconName && !useBody) ? icon(iconName, size === 'xs' ? 3 : 4) : '';
  const inner = useBody ? body : `${iconHtml}${escapeHtml(label)}`;
  const attrs = [
    id ? `id="${escapeHtml(id)}"` : '',
    ...Object.entries(dataset).map(([k, v]) => `data-${k}="${escapeHtml(v)}"`),
  ].filter(Boolean).join(' ');
  return `<span class="inline-flex items-center${gap} rounded-full ${fw} ${dims} ${palette}${cls}"${attrs ? ' ' + attrs : ''}>${inner}</span>`;
};
// badgeClasses returns just the class string, for callers that need to attach
// the palette to their own element (e.g. status pills where color depends on
// runtime state).
export const badgeClasses = (color, size = 'sm') => {
  const dims = size === 'xs' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return `inline-flex items-center rounded-full font-semibold ${dims} ${BADGE_COLORS[color] || BADGE_COLORS.slate}`;
};
