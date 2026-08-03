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
  fileRow:          CLS.fileRowBtn,
};
export const button = ({
  variant = 'primary', kind = 'button', type, href, id, label = '',
  icon: iconName, iconOnly = false, ariaLabel, disabled = false,
  extraClass = '', dataset = {}, body = '',
} = {}) => {
  const base = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary;
  const cls = `${base}${extraClass ? ' ' + extraClass : ''}`;
  const attrs = [
    id ? `id="${id}"` : '',
    ariaLabel ? `aria-label="${escapeHtml(ariaLabel)}"` : '',
    ...Object.entries(dataset).map(([k, v]) => `data-${k}="${escapeHtml(v)}"`),
  ].filter(Boolean).join(' ');
  const inner = body
    ? body
    : `${iconName ? icon(iconName) : ''}${iconOnly ? '' : `<span>${escapeHtml(label)}</span>`}`;
  if (kind === 'link') {
    return `<a class="${cls}" href="${href}"${attrs ? ' ' + attrs : ''}>${inner}</a>`;
  }
  const t = type || 'button';
  const dis = disabled ? ' disabled' : '';
  return `<button class="${cls}" type="${t}"${dis}${attrs ? ' ' + attrs : ''}>${inner}</button>`;
};

// Page → nav group, for the eyebrow above the serif title.
const NAV_GROUPS = {
  dashboard:    'workspace',
  profile:      'workspace',
  companies:    'collections',
  people:       'collections',
  applications: 'collections',
  settings:     'system',
};

// Quiet "no data yet" placeholder for structurally-present-but-empty section
// slots. Louder alternative is emptyState() (rounded box).
export const emptyDash = () => `<p class="text-sm ${CLS.placeholder}">—</p>`;

// Ordered bulleted list of escaped strings for slide-over body content.
// Uses tight vertical rhythm (space-y-1) so a list of 3–4 lines feels dense
// against the section header above it.
export const bulletList = (items) =>
  `<ul class="list-disc space-y-1 pl-5 text-sm text-ink-soft">${
    items.map(v => `<li>${escapeHtml(v)}</li>`).join('')
  }</ul>`;

// Clickable file-system row used in the collection index lists (Companies /
// Applications / People). Renders `<li>` + a full-width <button>. The row body
// is: optional avatar · [serif title + optional pill] · mono meta · chevron.
//
//   id:        record id — bound to data-panel-row on the <li> and dataset.id
//   jsClass:   handler-hook class (e.g. 'js-open', 'js-details', 'js-threads')
//   ariaLabel: raw string; escaped internally
//   avatar:    pre-rendered avatar HTML (optional, e.g. initials circle)
//   title:     serif title text (escaped internally)
//   pill:      pre-rendered pill HTML (optional)
//   meta:      mono meta string (escaped internally)
export const fileRow = ({
  id, jsClass, ariaLabel, avatar = '', title, pill = '', meta = '',
} = {}) => {
  const body = `
    ${avatar}
    <div class="min-w-0 flex-1 space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="${CLS.fileRowTitle}">${escapeHtml(title)}</span>
        ${pill}
      </div>
      ${meta ? `<div class="${CLS.fileRowMeta}">${escapeHtml(meta)}</div>` : ''}
    </div>
    <span class="text-ink-faint">${icon('chevronRight', 4)}</span>
  `;
  return `
    <li data-panel-row="${escapeHtml(id)}" class="border-b border-line last:border-b-0">
      ${button({ variant: 'fileRow', extraClass: jsClass, ariaLabel, dataset: { id }, body })}
    </li>`;
};

// Small uppercase mono-ish label above a slide-over subsection (used heavily
// in the Companies dossier body).
export const dossierLabel = (text) =>
  `<p class="text-xs font-medium uppercase tracking-wide text-ink-faint">${escapeHtml(text)}</p>`;

// <dt> label inside a description-list KV row (used in the Applications JD
// structured view).
export const dtLabel = (text) =>
  `<dt class="text-sm font-semibold text-ink-faint">${escapeHtml(text)}</dt>`;

// Preformatted code-style block — horizontally scrollable, wraps long lines.
// Text is escaped internally.
export const codeBlock = (text) =>
  `<pre class="overflow-x-auto rounded-2xl bg-surface p-4 whitespace-pre-wrap ${CLS.bodyText}">${escapeHtml(text)}</pre>`;

// Scrollable log-output panel — starts hidden; caller populates via JS.
export const logPanel = ({ id }) =>
  `<div id="${escapeHtml(id)}" class="hidden max-h-40 overflow-auto rounded-xl border border-line bg-paper p-3 font-mono text-[11px] text-ink-soft"></div>`;

// Narrative body paragraph — soft ink, preserves whitespace (LLM output).
export const narrativeText = (text) =>
  `<p class="text-sm text-ink-soft whitespace-pre-wrap">${escapeHtml(text)}</p>`;

// Small caption/help paragraph. For inline `<span>` variants or complex mixed
// content, keep using `<p class="${CLS.helpText}">…</p>` directly.
export const helpText = (text, { extraClass = '', id = '' } = {}) => {
  const cls = extraClass ? `${extraClass} ${CLS.helpText}` : CLS.helpText;
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return `<p class="${cls}"${idAttr}>${escapeHtml(text)}</p>`;
};

// Inline `<span>` variant of helpText — for placeholders inside larger
// paragraphs / <dd> cells / flex rows.
export const helpSpan = (text) =>
  `<span class="${CLS.helpText}">${escapeHtml(text)}</span>`;

// Color-only faint span — inherits size from parent. Use where you want just
// the faint color without forcing text-xs (e.g. dates in timeline items,
// em-dash placeholders inside KV cells).
export const faintSpan = (text) =>
  `<span class="text-ink-faint">${escapeHtml(text)}</span>`;

// Regular body paragraph (soft ink). Same shape as helpText, just larger text.
export const bodyText = (text, { extraClass = '', id = '' } = {}) => {
  const cls = extraClass ? `${extraClass} ${CLS.bodyText}` : CLS.bodyText;
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return `<p class="${cls}"${idAttr}>${escapeHtml(text)}</p>`;
};

// Mono meta caption — small monospace faint text for structured data.
export const metaText = (text, { extraClass = '', id = '' } = {}) => {
  const cls = extraClass ? `${extraClass} ${CLS.metaText}` : CLS.metaText;
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return `<p class="${cls}"${idAttr}>${escapeHtml(text)}</p>`;
};

// The "Filtered by company: X · Clear filter" banner used by Applications and
// People pages when the URL carries ?company_id=…
export const filterBanner = ({ label, name, clearHref, clearLabel }) => `
  <div class="${CLS.filterBanner}">
    <span>${escapeHtml(label)} <span class="font-semibold">${escapeHtml(name)}</span></span>
    <a href="${escapeHtml(clearHref)}" class="${CLS.brandLink} font-semibold">${escapeHtml(clearLabel)}</a>
  </div>
`;

// Serif h2 — subject line at the top of a slide-over/panel. Pass `text` for
// the common escape-and-render case, or `body` for trusted HTML (e.g. the
// title wraps a link).
export const panelTitle = (text, body = '') =>
  `<h2 class="font-display text-2xl font-medium leading-tight text-ink">${body || escapeHtml(text)}</h2>`;

// Serif h3 — inline section header inside a slide-over/panel.
export const sectionTitle = (text) =>
  `<h3 class="font-display text-lg font-medium text-ink">${escapeHtml(text)}</h3>`;

// Serif h2 — subsection heading (larger than sectionTitle).
export const subheadTitle = (text) =>
  `<h2 class="font-display text-lg font-semibold text-ink">${escapeHtml(text)}</h2>`;

// Serif h3 — small header inside a nested subsection (denser body content).
export const subsectionTitle = (text) =>
  `<h3 class="font-display text-base font-semibold text-ink">${escapeHtml(text)}</h3>`;

// FILE · CP-0042 style stamp. Prefixes are English-only.
const FILE_STAMP_PREFIX = { company: 'CP', person: 'PPL', application: 'APP' };
export const fileStamp = (kind, id) => {
  const p = FILE_STAMP_PREFIX[kind] || '';
  const ref = `${p}-${String(id).padStart(4, '0')}`;
  return `<p class="font-mono text-[0.72rem] tracking-wider text-ink-faint">FILE · ${escapeHtml(ref)}</p>`;
};

// pageHeader: mono eyebrow (group) → serif h1 (title) → tagline → count mount.
// Pass `page` to render the eyebrow; tagline undefined uses the default note,
// pass null to omit.
export const pageHeader = ({ page = '', title, tagline, countId = '' } = {}) => {
  const line = tagline === undefined ? t('common.page_tagline') : tagline;
  const group = NAV_GROUPS[page];
  const eyebrow = group ? `<p class="${CLS.eyebrow}">${escapeHtml(t(`nav.group.${group}`))}</p>` : '';
  return `
  <div class="space-y-2">
    ${eyebrow}
    <h1 class="font-display text-3xl font-semibold text-ink">${escapeHtml(title)}</h1>
    ${line ? `<p class="text-sm text-ink-faint"${countId ? ` id="${countId}-tagline"` : ''}>${escapeHtml(line)}</p>` : ''}
    ${countId ? `<p class="font-mono text-sm tabular-nums text-ink-faint" id="${countId}">${t('app.loading')}</p>` : ''}
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
        <summary class="cursor-pointer list-none text-base font-semibold text-ink">
          <span class="inline-flex items-center gap-2">
            <span>${escapeHtml(title)}</span>
            <span class="text-sm font-normal text-ink-faint group-open:hidden">${escapeHtml(summary)}</span>
            <span class="hidden text-sm font-normal text-ink-faint group-open:inline">${escapeHtml(openSummary)}</span>
          </span>
        </summary>
        ${content}
      </details>
    `;
  }
  return `
    <details class="${wrap}">
      <summary class="cursor-pointer list-none text-sm font-medium text-brand hover:text-brand-deep">
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
  const base = 'rounded-xl border border-status-out/30 bg-status-out-bg px-3 py-2 text-sm text-status-out';
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
  const base = 'rounded-xl border border-status-win/40 bg-status-win-bg px-3 py-2 text-sm text-status-win';
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
  const base = 'rounded-xl border border-brass/30 bg-brass-tint px-3 py-2 text-sm text-brass';
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
  const cls = `rounded-2xl bg-paper px-4 py-6 text-center text-sm text-ink-faint${extraClass ? ' ' + extraClass : ''}`;
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
    ${hint ? `<p class="text-xs text-ink-faint">${hint}</p>` : ''}
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
  const base = 'inline-flex h-5 w-5 items-center justify-center rounded-full opacity-60 hover:bg-status-out-bg hover:text-status-out hover:opacity-100';
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
    ? 'border-b-2 border-brand text-brand'
    : 'border-b-2 border-transparent text-ink-faint hover:text-ink';
  return `<button type="button" class="js-tab inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold transition ${state}" data-tab="${escapeHtml(name)}" role="tab" aria-selected="${active}">${escapeHtml(label)}<span data-tab-count="${escapeHtml(name)}" class="hidden rounded-full bg-line px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-ink-soft"></span></button>`;
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
  return `<button type="button" class="js-chip inline-flex items-center rounded-full border border-line-strong bg-surface px-3 py-1 text-xs text-ink-soft hover:border-brand hover:bg-brand-tint"${attrs ? ' ' + attrs : ''}>${escapeHtml(prefix + label)}</button>`;
};

// badge renders a Tailwind pill. Color must be one of the keys below; sizes
// map to 'xs' (px-2.5 py-0.5 text-xs) or 'sm' (px-3 py-1 text-sm, default).
// Class strings are literal (not template-interpolated tokens) so Tailwind's
// scanner picks them up.
const BADGE_COLORS = {
  slate:    'bg-status-hold-bg text-status-hold',
  blue:     'bg-brand-tint text-brand',
  cyan:     'bg-brand-tint text-brand',
  indigo:   'bg-status-lead-bg text-status-lead',
  violet:   'bg-pill-violet-bg text-pill-violet',
  emerald:  'bg-status-win-bg text-status-win',
  amber:    'bg-status-active-bg text-status-active',
  orange:   'bg-pill-orange-bg text-pill-orange',
  fuchsia:  'bg-pill-fuchsia-bg text-pill-fuchsia',
  rose:     'bg-status-out-bg text-status-out',
  red:      'bg-status-out-bg text-status-out',
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
