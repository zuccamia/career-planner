// Shared collection-index shell — toolbar (search + filter pills) and the
// bordered row-container/empty-state pair. Each page still owns its row
// template and its wire-up handlers.

import { CLS } from './classes.mjs';
import { icon } from './icons.mjs';
import { emptyState, inlineError } from './components.mjs';
import { escapeHtml } from './dom.mjs';

// Render the row list or the shared empty state.
//   rows:         array of already-rendered <li> HTML strings
//   emptyMessage: shown when rows is empty
export const collectionRowsHtml = ({ rows, emptyMessage }) => rows.length
  ? `<ul class="${CLS.rowList}">${rows.join('')}</ul>`
  : emptyState({ message: emptyMessage });

// Render the row of filter pills. Callers stash it into the filter mount
// on each filter change to update aria-selected + styling.
//   filters: [{ key, label }]
//   activeKey: string
export const filterPillsHtml = (filters, activeKey) =>
  filters.map(f => {
    const on = f.key === activeKey;
    return `<button type="button" data-filter="${f.key}" role="tab" aria-selected="${on}"
                    class="js-filter ${CLS.filterPill} ${on ? CLS.filterPillOn : CLS.filterPillOff}">
              ${escapeHtml(f.label)}
            </button>`;
  }).join('');

// Render the whole toolbar (search input + filter mount). Filter pills are
// injected into filtersId by the caller so the mount can be re-rendered on
// filter change without touching the search input's value/focus.
//   searchId, filtersId:            unique element ids
//   searchPlaceholder, filtersAriaLabel: localized strings
//   filters, activeFilter:          same shape as filterPillsHtml
export const collectionToolbarHtml = ({
  searchId, searchPlaceholder,
  filtersId = '', filtersAriaLabel = '',
  filters = [], activeFilter = '',
} = {}) => `
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
    <div class="relative flex-1">
      <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-faint">
        ${icon('search', 4)}
      </span>
      <input id="${escapeHtml(searchId)}" type="search" autocomplete="off"
             placeholder="${escapeHtml(searchPlaceholder)}"
             aria-label="${escapeHtml(searchPlaceholder)}"
             class="${CLS.searchInput}">
    </div>
    ${filtersId ? `
      <div id="${escapeHtml(filtersId)}" role="tablist" aria-label="${escapeHtml(filtersAriaLabel)}"
           class="flex flex-wrap gap-1.5">${filterPillsHtml(filters, activeFilter)}</div>
    ` : ''}
  </div>
`;

// Full list panel — the standard "space-y-4 section with inline-error mount,
// toolbar, and #list-content anchor" wrapper used by every collection page.
export const collectionListPanel = (toolbarProps) => `
  <section id="list-panel" class="space-y-4">
    ${inlineError({ id: 'list-error' })}
    ${collectionToolbarHtml(toolbarProps)}
    <div id="list-content"></div>
  </section>
`;
