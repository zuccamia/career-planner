// People page: list + inline editor for create/edit/delete + a threads panel
// for browsing communication history per person. Editor and threads panels
// are mutually exclusive (same pattern as companies.mjs' editor+dossier
// combo). LLM-backed thread summary and message drafting go through
// stateless RPCs — persistence stays local.

import {
  listPeople, getPerson, createPerson, updatePerson, deletePerson,
  findPersonByName,
} from '../entities/people.mjs';
import { listCompanies, getCompany } from '../entities/companies.mjs';
import {
  COMMUNICATION_CHANNELS, COMMUNICATION_DIRECTIONS,
  listThreadsByPersonID, getThread, createThread, updateThread, updateThreadStatus,
  updateThreadSummary, deleteThread, countThreadsByPersonID,
  listEntriesByThreadID, createEntry, deleteEntry,
} from '../entities/communications.mjs';
import { summarizeThread, generateMessage } from '../rpc.mjs';
import { urlFor } from '../host.mjs';
import { createProgress } from '../ui/progress.mjs';
import { escapeHtml, formatDate } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { badge, button, emptyState, fileRow, fileStamp, filterBanner, helpText, inlineError, setInlineError, metaText, outputLanguageSelect, pageHeader, panelTitle, readOutputLanguage, sectionTitle, setPageCount } from '../ui/components.mjs';
import { headlineStatus, listApplicationsByPerson } from '../entities/applications.mjs';
import { icon } from '../ui/icons.mjs';
import { rememberPanelAnchor, mountInlinePanel, restoreAllPanels } from '../ui/panels.mjs';
import { openSlideOver, closeSlideOver, isSlideOverOpen } from '../ui/slide_over.mjs';
import { collectionListPanel, collectionRowsHtml } from '../ui/collection_list.mjs';
import { relativeAge, initials } from '../ui/format.mjs';
import { refreshSidebarCounts } from '../ui/sidebar_counts.mjs';
import { t } from '../i18n.mjs';

const PANEL_IDS = ['editor-panel', 'threads-panel'];

// ---------- helpers ----------
const titleCase = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '';

const CHANNEL_BADGE_COLOR = {
  call: 'amber',
  meeting: 'orange',
  text: 'fuchsia',
  general: 'slate',
};

// All supported channels render as icons instead of pills so the thread list
// scans quickly.
const CHANNEL_ICONS = new Set(['email', 'handshake', 'linkedin', 'facebook', 'phone', 'meeting', 'text']);

const channelBadge = (channel) => {
  if (CHANNEL_ICONS.has(channel)) {
    return `<span class="inline-flex items-center" title="${titleCase(channel)}" aria-label="${titleCase(channel)}">
      ${icon(channel, 4)}
    </span>`;
  }
  return badge({
    color: CHANNEL_BADGE_COLOR[channel] || 'slate',
    size: 'xs',
    label: titleCase(channel),
  });
};

// Direction glyph rendered as a small colored circle. Mirrors the legacy
// entry-show template (arrow-in / arrow-out / note paper) so both surfaces
// signal direction the same way.
const DIRECTION_STYLES = {
  inbound:  { icon: 'arrowIn',  circle: 'bg-status-win-bg text-status-win', label: 'Inbound' },
  outbound: { icon: 'arrowOut', circle: 'bg-brand-tint text-brand',         label: 'Outbound' },
  note:     { icon: 'note',     circle: 'bg-paper text-ink-soft',     label: 'Note' },
};

const directionIcon = (direction) => {
  const style = DIRECTION_STYLES[direction] || DIRECTION_STYLES.note;
  return `<span class="inline-flex h-8 w-8 items-center justify-center rounded-full ${style.circle}" title="${style.label}" aria-label="${style.label}">
    ${icon(style.icon, 4)}
  </span>`;
};

// Auto-detects the social network from the URL host so people can store a
// LinkedIn, Facebook, or generic profile link in the same column. Falls back
// to the generic 'link' icon for anything unrecognized.
const socialNetworkFromURL = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('linkedin.com')) return { icon: 'linkedin', label: 'LinkedIn' };
    if (host.includes('facebook.com') || host === 'fb.com' || host.endsWith('.fb.com')) return { icon: 'facebook', label: 'Facebook' };
  } catch { /* not a valid URL */ }
  return { icon: 'link', label: 'Profile' };
};

const socialIconLink = (url) => {
  if (!url) return '';
  const { icon: name, label } = socialNetworkFromURL(url);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${label}" aria-label="${label}"
        class="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-faint hover:bg-paper hover:text-brand transition">
      ${icon(name, 3.5)}
    </a>`;
};

// ---------- markup ----------
const shellHtml = () => `
  <div class="space-y-6">
    <div id="toast" class="hidden"></div>

    <section class="${CLS.pageHeadRow}">
      ${pageHeader({ page: 'people', title: t('page.people.title'), countId: 'people-count' })}
      ${button({ id: 'btn-new', variant: 'primaryCompact', icon: 'plus', label: t('people.action.new'), ariaLabel: t('people.aria.add') })}
    </section>

    <section id="editor-panel" class="hidden"></section>
    <section id="threads-panel" class="hidden"></section>

    ${collectionListPanel({
      searchId: 'people-search',
      searchPlaceholder: t('people.search.placeholder'),
    })}
  </div>
`;

const editorHtml = (person, companies) => {
  const isNew = !person;
  const p = person || {};
  const selectedCompany = isNew ? '' : String(p.company_id ?? '');
  const companyOptions = [
    `<option value="" ${selectedCompany ? '' : 'selected'}>${t('people.field.company.none')}</option>`,
    ...companies.map(c => `
      <option value="${c.id}" ${String(c.id) === selectedCompany ? 'selected' : ''}>
        ${escapeHtml(c.official_name)}
      </option>`),
  ].join('');
  return `
    <div class="${CLS.card}">
      <form id="editor-form" class="space-y-5">
        <div class="${CLS.formHeadRow}">
          <p class="${CLS.eyebrow}">${isNew ? t('people.form.new_eyebrow') : t('people.form.edit_eyebrow')}</p>
          <div class="${CLS.rowInline}">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: isNew ? t('people.form.aria.create') : t('common.action.save_changes') })}
            ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.cancel') })}
          </div>
        </div>

        ${inlineError({ id: 'editor-error' })}

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:items-start">
          <div class="grid gap-2">
            <label class="${CLS.label}" for="full_name">${t('people.field.full_name.label')}</label>
            <input id="full_name" name="full_name" type="text" required
                   value="${escapeHtml(p.full_name)}" placeholder="${t('people.field.full_name.placeholder')}"
                   class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="title">${t('people.field.title.label')}</label>
            <input id="title" name="title" type="text"
                   value="${escapeHtml(p.title)}" placeholder="${t('people.field.title.placeholder')}"
                   class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="company_id">${t('people.field.company.label')}</label>
            <select id="company_id" name="company_id" class="${CLS.select}">
              ${companyOptions}
            </select>
            <p class="${CLS.helpText}">
              ${t('people.field.company.help_prefix')} <a href="${urlFor('companies?new=1')}" class="${CLS.brandLink}">${t('people.field.company.help_link')}</a> ${t('people.field.company.help_suffix')}
            </p>
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="social_url">${t('people.field.social.label')}</label>
            <input id="social_url" name="social_url" type="url"
                   value="${escapeHtml(p.social_url)}" placeholder="${t('people.field.social.placeholder')}"
                   class="${CLS.input}">
          </div>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="notes">${t('people.field.notes.label')}</label>
          <textarea id="notes" name="notes" rows="4" class="${CLS.textarea}"
                    placeholder="${t('people.field.notes.placeholder')}">${escapeHtml(p.notes)}</textarea>
          ${helpText(t('people.field.notes.help'))}
        </div>
      </form>
    </div>
  `;
};

const rowMeta = (p) => {
  const parts = [];
  if (p.title) parts.push(p.title);
  if (p.company_name) parts.push(p.company_name);
  parts.push(t('common.updated_at', { date: formatDate(p.updated_at) }));
  return parts.join('  ·  ');
};

const personFileRow = (p, threadCount) => fileRow({
  id: p.id,
  jsClass: 'js-threads',
  ariaLabel: t('people.aria.open', { name: p.full_name }),
  avatar: `<div class="${CLS.avatarBadge}">${escapeHtml(initials(p.full_name))}</div>`,
  title: p.full_name,
  pill: threadCount > 0
    ? badge({ color: 'blue', size: 'xs', label: threadCount === 1 ? t('people.list.threads_one', { n: threadCount }) : t('people.list.threads_many', { n: threadCount }) })
    : '',
  meta: rowMeta(p),
});

// ---------- threads panel ----------

const threadsHeaderHtml = (person) => {
  const social = (person.social_url || '').trim();
  const nameHtml = social
    ? `<a href="${escapeHtml(social)}" target="_blank" rel="noopener noreferrer" class="hover:text-brand hover:underline">${escapeHtml(person.full_name)}</a>`
    : '';
  return `
  <header class="space-y-2">
    <div class="flex items-center justify-between gap-3">
      ${fileStamp('person', person.id)}
      <div class="${CLS.rowInline}">
        ${button({ id: 'btn-person-edit', variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: t('people.aria.edit') })}
        ${button({ id: 'btn-threads-delete', variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('people.aria.delete', { name: person.full_name }) })}
        ${button({ id: 'btn-threads-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.close') })}
      </div>
    </div>
    <div class="${CLS.textCol}">
      ${panelTitle(person.full_name, nameHtml)}
      ${person.title || person.company_name ? metaText(
        `${person.title || ''}${person.title && person.company_name ? '  ·  ' : ''}${person.company_name || ''}`,
      ) : ''}
    </div>
  </header>
  ${inlineError({ id: 'threads-error' })}
  <div id="threads-progress" class="hidden"></div>
`;
};

// threadFormHtml renders the subject+channel form used for both create and
// edit. `mode` selects the eyebrow label, form id, and aria labels.
// `initial` pre-fills the fields (empty for create).
const threadFormHtml = ({ mode, initial = {} }) => {
  const isEdit = mode === 'edit';
  const eyebrowKey = isEdit ? 'people.thread_form.edit_eyebrow' : 'people.thread_form.new_eyebrow';
  const saveAria   = isEdit ? 'people.aria.save_thread_edit'   : 'people.aria.create_thread';
  const cancelAria = isEdit ? 'people.aria.cancel_thread_edit' : 'people.aria.cancel_new_thread';
  const formId     = isEdit ? 'edit-thread-form'   : 'new-thread-form';
  const cancelId   = isEdit ? 'btn-cancel-edit-thread' : 'btn-cancel-new-thread';
  const errorId    = isEdit ? 'edit-thread-error'  : 'new-thread-error';
  const subjectId  = isEdit ? 'edit_thread_subject' : 'new_thread_subject';
  const channelId  = isEdit ? 'edit_thread_channel' : 'new_thread_channel';
  const subject    = initial.subject ?? '';
  const channel    = initial.channel ?? '';
  return `
  <form id="${formId}" class="${CLS.paperCard} space-y-3">
    <div class="${CLS.formHeadRow}">
      <p class="${CLS.eyebrow}">${t(eyebrowKey)}</p>
      <div class="${CLS.rowInline}">
        ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t(saveAria) })}
        ${button({ id: cancelId, variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t(cancelAria) })}
      </div>
    </div>
    ${inlineError({ id: errorId })}
    <div class="grid gap-3 sm:grid-cols-3">
      <div class="grid gap-1 sm:col-span-2">
        <label class="${CLS.label}" for="${subjectId}">${t('people.thread_form.subject.label')}</label>
        <input id="${subjectId}" name="subject" type="text" required value="${escapeHtml(subject)}"
               class="${CLS.input}" placeholder="${t('people.thread_form.subject.placeholder')}">
      </div>
      <div class="grid gap-1">
        <label class="${CLS.label}" for="${channelId}">${t('people.thread_form.channel.label')}</label>
        <select id="${channelId}" name="channel" class="${CLS.select}">
          ${COMMUNICATION_CHANNELS.map(c => `<option value="${c}"${c === channel ? ' selected' : ''}>${titleCase(c)}</option>`).join('')}
        </select>
      </div>
    </div>
  </form>
`;
};

const newThreadFormHtml = () => threadFormHtml({ mode: 'new' });

const threadListHtml = (threads, openThreadID) => {
  if (!threads.length) {
    return emptyState({ message: t('people.threads.empty') });
  }
  return `
    <ul class="space-y-3">
      ${threads.map(th => {
        const expanded = th.id === openThreadID;
        return `
          <li>
            <div class="${CLS.surfaceCard} ${expanded ? 'ring-1 ring-brand/30' : ''}">
              <div class="${CLS.cardHeadRow}">
                <div class="space-y-1 min-w-0">
                  <div class="${CLS.chipRowInline}">
                    ${channelBadge(th.channel)}
                    ${badge({ color: th.status === 'open' ? 'emerald' : 'slate', size: 'xs', label: th.status === 'open' ? t('people.threads.status_open') : t('people.threads.status_closed') })}
                    <span class="font-semibold text-ink">${escapeHtml(th.subject) || `<span class="${CLS.placeholder}">${t('people.threads.untitled')}</span>`}</span>
                  </div>
                  <p class="${CLS.helpText}">
                    ${th.summary
                      ? t('people.threads.last_activity', { date: formatDate(th.last_activity_at), summary: escapeHtml(th.summary) })
                      : t('people.threads.last_activity_no_summary', { date: formatDate(th.last_activity_at) })}
                  </p>
                </div>
                <div class="${CLS.headActions}">
                  ${button({ variant: 'secondaryCompact', label: expanded ? t('people.action.hide') : t('people.action.open_thread'), extraClass: 'js-toggle-thread', dataset: { id: th.id } })}
                  ${button({
                    variant: 'icon',
                    icon: th.status === 'open' ? 'linkSlash' : 'link',
                    iconOnly: true,
                    ariaLabel: th.status === 'open' ? t('people.aria.close_thread') : t('people.aria.reopen_thread'),
                    extraClass: 'js-toggle-status',
                    dataset: { id: th.id, status: th.status },
                  })}
                  ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: t('people.aria.edit_thread', { subject: th.subject }), extraClass: 'js-edit-thread', dataset: { id: th.id } })}
                  ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('people.aria.delete_thread', { subject: th.subject }), extraClass: 'js-delete-thread', dataset: { id: th.id, subject: th.subject } })}
                </div>
              </div>
              <div id="thread-edit-container-${th.id}"></div>
              ${expanded ? `<div id="thread-detail-${th.id}" class="mt-4 ${CLS.dividerTop}"></div>` : ''}
            </div>
          </li>`;
      }).join('')}
    </ul>`;
};

// Show "more" toggle when content spans multiple lines or would visually
// overflow the single-line clamp. Threshold matches roughly one row of text
// in the card width; err generous to avoid a "more" that does nothing.
const isMultiLineContent = (s) => s.includes('\n') || s.length > 80;

const entryHtml = (e) => {
  const collapsible = isMultiLineContent(e.content);
  return `
    <li class="${CLS.entryRow}">
      <div class="shrink-0">
        ${directionIcon(e.direction)}
      </div>
      <div class="min-w-0 flex-1">
        <p class="${CLS.helpText}">${formatDate(e.occurred_at)}</p>
        <p class="js-entry-content ${collapsible ? 'line-clamp-1' : 'whitespace-pre-wrap'} text-sm text-ink"
           data-collapsed="${collapsible ? '1' : '0'}">${escapeHtml(e.content)}</p>
        ${collapsible ? `<button type="button" class="js-toggle-entry mt-1 ${CLS.tinyLink}" data-id="${e.id}">${t('people.action.more')}</button>` : ''}
      </div>
      ${button({
        variant: 'dangerIcon', icon: 'trash', iconOnly: true,
        ariaLabel: t('people.aria.delete_entry'), extraClass: 'js-delete-entry',
        dataset: { id: e.id },
      })}
    </li>
  `;
};

const threadDetailHtml = (thread, entries) => `
  <div class="space-y-4">
    <div class="space-y-1">
      <div class="${CLS.chipRow}">
        ${button({ id: 'btn-new-entry', variant: 'primaryCompact', icon: 'plus', label: t('people.action.new_entry'), ariaLabel: t('people.aria.add_entry') })}
        ${button({ id: 'btn-generate-outreach', variant: 'secondaryCompact', icon: 'sparkles', label: t('people.action.draft_outreach') })}
        ${button({ id: 'btn-generate-reply', variant: 'secondaryCompact', icon: 'sparkles', label: t('people.action.draft_reply') })}
        <div class="${CLS.rowInline}">
          ${outputLanguageSelect('out-lang-summary')}
          ${button({ id: 'btn-summarize', variant: 'secondaryCompact', icon: 'sparkles', label: thread.summary ? t('people.action.resummarize') : t('people.action.summarize') })}
        </div>
      </div>
      ${helpText(t('people.threads.language_note'))}
    </div>

    <div id="draft-panel" class="hidden"></div>

    <div id="new-entry-container"></div>

    ${entries.length ? `
      <ul class="space-y-2">${entries.map(entryHtml).join('')}</ul>
    ` : `
      ${emptyState({ message: t('people.entry.empty') })}
    `}
  </div>
`;

// Returns "YYYY-MM-DD" for today in local time — the value shape date inputs
// accept. We store the moment as an ISO timestamp so downstream code (LLM
// context, sorting) still gets a real Date; the date-only input just lets
// the user backfill without picking a time.
const todayLocalDate = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const newEntryFormHtml = () => `
  <form id="new-entry-form" class="space-y-3 rounded-xl border border-line bg-surface p-3">
    <div class="${CLS.formHeadRow}">
      <p class="${CLS.eyebrow}">${t('people.entry_form.new_eyebrow')}</p>
      <div class="${CLS.rowInline}">
        ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('people.aria.create_entry') })}
        ${button({ id: 'btn-cancel-new-entry', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('people.aria.cancel_new_entry') })}
      </div>
    </div>
    ${inlineError({ id: 'new-entry-error' })}
    <div class="${CLS.gridTwoCol} gap-3 sm:items-start">
      <div class="grid gap-1">
        <label class="${CLS.label}" for="entry_direction">${t('people.entry_form.direction.label')}</label>
        <select id="entry_direction" name="direction" class="${CLS.select}">
          ${COMMUNICATION_DIRECTIONS.map(d => `<option value="${d}">${titleCase(d)}</option>`).join('')}
        </select>
      </div>
      <div class="grid gap-1">
        <label class="${CLS.label}" for="entry_occurred_at">${t('people.entry_form.occurred_at.label')}</label>
        <input id="entry_occurred_at" name="occurred_at" type="date"
               value="${todayLocalDate()}" class="${CLS.input}">
      </div>
    </div>
    <div class="grid gap-1">
      <label class="${CLS.label}" for="entry_content">${t('people.entry_form.content.label')}</label>
      <textarea id="entry_content" name="content" rows="3" required class="${CLS.textarea}"
                placeholder="${t('people.entry_form.content.placeholder')}"></textarea>
    </div>
  </form>
`;

const draftPanelHtml = (goal, message) => `
  <div class="space-y-3 rounded-xl border border-brand/20 bg-brand-tint/40 p-3">
    <div class="${CLS.formHeadRow}">
      <p class="${CLS.eyebrow}">${t('people.draft.eyebrow', { goal })}</p>
      <div class="${CLS.rowInline}">
        ${button({ id: 'btn-save-draft', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('people.aria.save_draft_entry') })}
        ${button({ id: 'btn-discard-draft', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('people.aria.discard_draft') })}
      </div>
    </div>
    ${inlineError({ id: 'draft-error' })}
    <textarea id="draft-message" rows="6" class="${CLS.textarea}">${escapeHtml(message)}</textarea>
  </div>
`;

// ---------- state ----------
let editorMode = null;              // null | 'new' | { id }
let openThreadsPerson = null;       // person row when threads panel is open
let openThreadID = null;            // currently expanded thread within that panel
// Optional company_id filter (from ?company_id=… — set by company-card pill).
let companyFilter = null;           // { id, name } | null

const filterBannerHtml = () => companyFilter
  ? filterBanner({
      label: t('common.filter.by_company'),
      name: companyFilter.name,
      clearHref: urlFor('people'),
      clearLabel: t('common.filter.clear'),
    })
  : '';

// ---------- list handlers ----------
let filterState = { query: '' };
let cachedPeople = [];
let cachedThreadCounts = new Map();

const applyFilters = () => {
  const q = filterState.query.trim().toLowerCase();
  return cachedPeople.filter(p => {
    if (companyFilter && p.company_id !== companyFilter.id) return false;
    if (q) {
      const hay = `${p.full_name || ''} ${p.title || ''} ${p.company_name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
};

const renderList = () => {
  const filtered = applyFilters();
  restoreAllPanels(PANEL_IDS);
  document.getElementById('list-content').innerHTML =
    filterBannerHtml()
    + collectionRowsHtml({
        rows: filtered.map(p => personFileRow(p, cachedThreadCounts.get(p.id) ?? 0)),
        emptyMessage: t('people.list.empty'),
      });
  if (editorMode && editorMode !== 'new') mountInlinePanel('editor-panel', editorMode.id);
  setPageCount('people-count', filtered.length, n => companyFilter
    ? (n === 1 ? t('people.list.count_one_at_company', { n, company: companyFilter.name }) : t('people.list.count_many_at_company', { n, company: companyFilter.name }))
    : (n === 1 ? t('people.list.count_one_all', { n }) : t('people.list.count_many_all', { n })));
  wireListHandlers();
};

const wireListHandlers = () => {
  document.querySelectorAll('.js-threads').forEach(btn =>
    btn.addEventListener('click', () => openThreads(Number(btn.dataset.id), btn)));
};

const refreshList = async () => {
  const all = await listPeople();
  cachedPeople = all;
  const counts = new Map();
  await Promise.all(all.map(async (p) => {
    counts.set(p.id, await countThreadsByPersonID(p.id));
  }));
  cachedThreadCounts = counts;
  renderList();
  refreshSidebarCounts().catch(() => {});
};

const deletePersonFromList = async (personID, name, errorID = 'list-error') => {
  if (!confirm(t('people.confirm.delete', { name }))) return;
  setInlineError(errorID, '');
  try {
    await deletePerson(personID);
    if (editorMode && editorMode !== 'new' && editorMode.id === personID) closeEditor();
    if (openThreadsPerson && openThreadsPerson.id === personID) closeThreads();
    toast(t('people.toast.deleted'), 'ok');
    await refreshList();
  } catch (err) {
    setInlineError(errorID, t('people.error.delete_linked', { err: err.message }));
  }
};

// ---------- editor ----------
const openEditor = async (mode) => {
  closeThreads();
  editorMode = mode;
  const panel = document.getElementById('editor-panel');
  panel.classList.remove('hidden');

  let person = null;
  if (mode !== 'new') {
    person = await getPerson(mode.id);
    if (!person) {
      toast(t('people.error.not_found', { id: mode.id }), 'error');
      closeEditor();
      return;
    }
  }
  const companies = await listCompanies();
  panel.innerHTML = editorHtml(person, companies);
  wireEditor();
  mountInlinePanel('editor-panel', mode === 'new' ? null : mode.id);
  panel.querySelector('input[name="full_name"]')?.focus();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const closeEditor = () => {
  editorMode = null;
  mountInlinePanel('editor-panel', null);
  const panel = document.getElementById('editor-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
};

const readEditorForm = (form) => {
  const fd = new FormData(form);
  return {
    full_name: (fd.get('full_name') || '').toString().trim(),
    title: (fd.get('title') || '').toString().trim(),
    company_id: fd.get('company_id') ? Number(fd.get('company_id')) : null,
    social_url: (fd.get('social_url') || '').toString().trim(),
    notes: (fd.get('notes') || '').toString(),
  };
};

const wireEditor = ({ onCancel, onSaved } = {}) => {
  const cancelFn = onCancel || closeEditor;
  const savedFn = onSaved || (async () => { closeEditor(); await refreshList(); });
  const form = document.getElementById('editor-form');
  document.getElementById('btn-cancel').addEventListener('click', cancelFn);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setInlineError('editor-error', '');
    const data = readEditorForm(form);
    if (!data.full_name) {
      setInlineError('editor-error', t('people.error.full_name_required'));
      return;
    }
    try {
      if (editorMode === 'new') {
        const existing = await findPersonByName(data.full_name);
        if (existing) {
          setInlineError('editor-error', t('people.error.already_exists', { name: data.full_name, id: existing.id }));
          return;
        }
        const id = await createPerson(data);
        toast(t('people.toast.created', { id }), 'ok');
      } else {
        await updatePerson(editorMode.id, data);
        toast(t('people.toast.saved'), 'ok');
      }
      await savedFn();
    } catch (err) {
      setInlineError('editor-error', t('common.error.save_failed', { err: err.message }));
    }
  });
};

// ---------- threads panel ----------
const openThreads = async (personID, triggerEl = null) => {
  closeEditor();
  const person = await getPerson(personID);
  if (!person) {
    toast(t('people.error.not_found', { id: personID }), 'error');
    return;
  }
  openThreadsPerson = person;
  openThreadID = null;
  await renderThreads();
  openSlideOver({
    panelId: 'threads-panel',
    trigger: triggerEl,
    onClose: () => {
      openThreadsPerson = null;
      openThreadID = null;
      editorMode = null;
    },
  });
};

const closeThreads = () => {
  if (isSlideOverOpen('threads-panel')) {
    closeSlideOver('threads-panel');
    return;
  }
  openThreadsPerson = null;
  openThreadID = null;
  const panel = document.getElementById('threads-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
};

const applicationsSectionHtml = (apps, personID) => {
  if (!apps.length) return '';
  const rows = apps.map(a => {
    const statusText = t(`applications.status.headline.${headlineStatus(a.status)}`);
    const meta = [a.company_name, statusText, relativeAge(a.updated_at)]
      .filter(Boolean).join(' · ');
    return `
      <div class="${CLS.staticRow}">
        <div class="${CLS.flexTextCol}">
          <p class="${CLS.rowTitle}">${escapeHtml(a.role_title)}</p>
          <p class="${CLS.fileRowMeta}">${escapeHtml(meta)}</p>
        </div>
      </div>`;
  }).join('');
  const viewLink = `<a href="${urlFor(`applications?person_id=${personID}`)}" class="${CLS.linkAction}">${t('common.action.view')}</a>`;
  return `
    <section class="space-y-2">
      <div class="${CLS.sectionHead}">
        ${sectionTitle(t('companies.dossier.applications.heading'))}
        ${viewLink}
      </div>
      <div class="${CLS.divider}">${rows}</div>
    </section>`;
};

// Two entry points for the threads slide-over. Both mount into #threads-panel
// but render different bodies — no shared boolean flag. Callers pick which one
// matches the intent (list vs edit-person). renderThreads dispatches based on
// current state; direct callers should prefer the specific renderer.

const renderThreads = () => renderThreadsList();

const renderThreadsList = async () => {
  if (!openThreadsPerson) return;
  const panel = document.getElementById('threads-panel');
  const threads = await listThreadsByPersonID(openThreadsPerson.id);
  const apps = await listApplicationsByPerson(openThreadsPerson.id);
  panel.innerHTML = `
    <div class="${CLS.slideOverBody}">
      ${threadsHeaderHtml(openThreadsPerson)}
      ${applicationsSectionHtml(apps, openThreadsPerson.id)}
      <div class="flex justify-end">
        ${button({ id: 'btn-new-thread', icon: 'plus', variant: 'primaryCompact', label: t('people.action.new_thread'), ariaLabel: t('people.aria.add_thread') })}
      </div>
      <div id="new-thread-container"></div>
      <div id="thread-list">${threadListHtml(threads, openThreadID)}</div>
    </div>
  `;
  wireThreadsPanel();
  if (openThreadID) {
    await renderThreadDetail(openThreadID);
  }
};

const renderPersonEditorInPanel = async () => {
  if (!openThreadsPerson) return;
  const panel = document.getElementById('threads-panel');
  const companies = await listCompanies();
  panel.innerHTML = `
    <div class="${CLS.slideOverBody}">
      ${threadsHeaderHtml(openThreadsPerson)}
      ${editorHtml(openThreadsPerson, companies)}
    </div>
  `;
  wireThreadsPanel();
  editorMode = { id: openThreadsPerson.id };
  wireEditor({
    onCancel: () => {
      editorMode = null;
      renderThreadsList();
    },
    onSaved: async () => {
      editorMode = null;
      // The saved person may have a new name/company — pick up fresh values.
      const fresh = await getPerson(openThreadsPerson.id);
      if (fresh) openThreadsPerson = fresh;
      await refreshList();
      await renderThreadsList();
    },
  });
};

const wireThreadsPanel = () => {
  document.getElementById('btn-threads-close')?.addEventListener('click', closeThreads);
  document.getElementById('btn-new-thread')?.addEventListener('click', openNewThreadForm);
  document.getElementById('btn-person-edit')?.addEventListener('click', () => {
    if (!openThreadsPerson) return;
    renderPersonEditorInPanel();
  });
  document.getElementById('btn-threads-delete')?.addEventListener('click', () => {
    if (!openThreadsPerson) return;
    deletePersonFromList(openThreadsPerson.id, openThreadsPerson.full_name, 'threads-error');
  });

  document.querySelectorAll('.js-toggle-thread').forEach(btn =>
    btn.addEventListener('click', () => toggleThread(Number(btn.dataset.id))));
  document.querySelectorAll('.js-toggle-status').forEach(btn =>
    btn.addEventListener('click', () => toggleThreadStatus(Number(btn.dataset.id), btn.dataset.status)));
  document.querySelectorAll('.js-edit-thread').forEach(btn =>
    btn.addEventListener('click', () => openEditThreadForm(Number(btn.dataset.id))));
  document.querySelectorAll('.js-delete-thread').forEach(btn =>
    btn.addEventListener('click', () => deleteThreadFromList(Number(btn.dataset.id), btn.dataset.subject)));
};

const openNewThreadForm = () => {
  const container = document.getElementById('new-thread-container');
  container.innerHTML = newThreadFormHtml();
  container.querySelector('#new_thread_subject')?.focus();
  document.getElementById('btn-cancel-new-thread').addEventListener('click', () => {
    container.innerHTML = '';
  });
  document.getElementById('new-thread-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setInlineError('new-thread-error', '');
    const fd = new FormData(ev.target);
    const subject = (fd.get('subject') || '').toString().trim();
    if (!subject) {
      setInlineError('new-thread-error', t('people.error.subject_required'));
      return;
    }
    try {
      const id = await createThread({
        person_id: openThreadsPerson.id,
        subject,
        channel: fd.get('channel'),
        status: 'open',
      });
      toast(t('people.toast.thread_created', { id }), 'ok');
      openThreadID = id;
      await renderThreads();
      await refreshList();
    } catch (err) {
      setInlineError('new-thread-error', t('people.error.create_thread_failed', { err: err.message }));
    }
  });
};

const openEditThreadForm = async (threadID) => {
  const thread = await getThread(threadID);
  if (!thread) return;
  const container = document.getElementById(`thread-edit-container-${threadID}`);
  if (!container) return;
  container.innerHTML = threadFormHtml({ mode: 'edit', initial: thread });
  container.querySelector('#edit_thread_subject')?.focus();
  document.getElementById('btn-cancel-edit-thread').addEventListener('click', () => {
    container.innerHTML = '';
  });
  document.getElementById('edit-thread-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setInlineError('edit-thread-error', '');
    const fd = new FormData(ev.target);
    const subject = (fd.get('subject') || '').toString().trim();
    if (!subject) {
      setInlineError('edit-thread-error', t('people.error.subject_required'));
      return;
    }
    try {
      await updateThread(threadID, { subject, channel: fd.get('channel') });
      toast(t('people.toast.thread_updated'), 'ok');
      await renderThreadsList();
    } catch (err) {
      setInlineError('edit-thread-error', err.message);
    }
  });
};

const toggleThread = async (threadID) => {
  openThreadID = openThreadID === threadID ? null : threadID;
  await renderThreads();
};

const toggleThreadStatus = async (threadID, currentStatus) => {
  const next = currentStatus === 'open' ? 'closed' : 'open';
  setInlineError('threads-error', '');
  try {
    await updateThreadStatus(threadID, next);
    toast(next === 'open' ? t('people.toast.thread_open') : t('people.toast.thread_closed'), 'ok');
    await renderThreads();
  } catch (err) {
    setInlineError('threads-error', t('people.error.status_change_failed', { err: err.message }));
  }
};

const deleteThreadFromList = async (threadID, subject) => {
  if (!confirm(t('people.confirm.delete_thread', { subject }))) return;
  setInlineError('threads-error', '');
  try {
    await deleteThread(threadID);
    if (openThreadID === threadID) openThreadID = null;
    toast(t('people.toast.thread_deleted'), 'ok');
    await renderThreads();
    await refreshList();
  } catch (err) {
    setInlineError('threads-error', t('common.error.delete_failed', { err: err.message }));
  }
};

// ---------- thread detail (entries + LLM buttons) ----------
const renderThreadDetail = async (threadID) => {
  const container = document.getElementById(`thread-detail-${threadID}`);
  if (!container) return;
  const [thread, entries] = await Promise.all([
    getThread(threadID),
    listEntriesByThreadID(threadID),
  ]);
  if (!thread) return;
  container.innerHTML = threadDetailHtml(thread, entries);
  wireThreadDetail(thread, entries);
};

const wireThreadDetail = (thread, entries) => {
  const container = document.getElementById(`thread-detail-${thread.id}`);

  container.querySelector('#btn-new-entry').addEventListener('click', () => openNewEntryForm(thread));

  container.querySelectorAll('.js-delete-entry').forEach(btn =>
    btn.addEventListener('click', () => deleteEntryFromDetail(thread.id, Number(btn.dataset.id))));

  container.querySelectorAll('.js-toggle-entry').forEach(btn =>
    btn.addEventListener('click', () => toggleEntryContent(btn)));

  container.querySelector('#btn-summarize').addEventListener('click', () => runSummarize(thread, entries));
  container.querySelector('#btn-generate-outreach').addEventListener('click', () => runGenerate(thread, entries, 'outreach'));
  container.querySelector('#btn-generate-reply').addEventListener('click', () => runGenerate(thread, entries, 'reply'));
};

const openNewEntryForm = (thread) => {
  const container = document.querySelector(`#thread-detail-${thread.id} #new-entry-container`);
  if (!container) return;
  // Second click on the CTA collapses the form.
  if (container.innerHTML.trim()) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = newEntryFormHtml();
  container.querySelector('#entry_content')?.focus();
  document.getElementById('btn-cancel-new-entry').addEventListener('click', () => {
    container.innerHTML = '';
  });
  document.getElementById('new-entry-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setInlineError('new-entry-error', '');
    const fd = new FormData(ev.target);
    const content = (fd.get('content') || '').toString().trim();
    if (!content) {
      setInlineError('new-entry-error', t('people.error.entry_content_required'));
      return;
    }
    // A date input yields bare "YYYY-MM-DD", which `new Date(s)` treats as
    // UTC midnight and shifts by the browser's tz. Append "T00:00" so the
    // constructor reads it as local time, then convert to UTC ISO for
    // storage. Empty value falls back to now via the entity layer's default.
    const rawOccurred = (fd.get('occurred_at') || '').toString();
    const occurredAt = rawOccurred ? new Date(`${rawOccurred}T00:00`).toISOString() : undefined;
    try {
      await createEntry({
        thread_id: thread.id,
        direction: fd.get('direction'),
        content,
        occurred_at: occurredAt,
      });
      toast(t('people.toast.entry_added'), 'ok');
      await renderThreadDetail(thread.id);
    } catch (err) {
      setInlineError('new-entry-error', t('people.error.add_entry_failed', { err: err.message }));
    }
  });
};

// Toggle the line-clamp on a specific entry's content <p>. Sibling button
// text flips between more/less. Runs entirely in-DOM — no re-render needed.
const toggleEntryContent = (btn) => {
  const contentEl = btn.previousElementSibling;
  if (!contentEl) return;
  const collapsed = contentEl.dataset.collapsed === '1';
  if (collapsed) {
    contentEl.classList.remove('line-clamp-1');
    contentEl.classList.add('whitespace-pre-wrap');
    contentEl.dataset.collapsed = '0';
    btn.textContent = t('people.action.less');
  } else {
    contentEl.classList.add('line-clamp-1');
    contentEl.classList.remove('whitespace-pre-wrap');
    contentEl.dataset.collapsed = '1';
    btn.textContent = t('people.action.more');
  }
};

const deleteEntryFromDetail = async (threadID, entryID) => {
  if (!confirm(t('people.confirm.delete_entry'))) return;
  setInlineError('threads-error', '');
  try {
    await deleteEntry(entryID);
    toast(t('people.toast.entry_deleted'), 'ok');
    await renderThreadDetail(threadID);
  } catch (err) {
    setInlineError('threads-error', t('people.error.delete_entry_failed', { err: err.message }));
  }
};

const buildPayload = (thread, entries) => ({
  thread: {
    person_name: thread.person_name,
    person_notes: thread.person_notes,
    channel: thread.channel,
    subject: thread.subject,
    status: thread.status,
    summary: thread.summary,
  },
  entries: entries.map(e => ({
    direction: e.direction,
    content: e.content,
    occurred_at: e.occurred_at,
  })),
});

const runSummarize = async (thread, entries) => {
  const btn = document.getElementById('btn-summarize');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Summarizing…</span>';
  setInlineError('threads-error', '');
  const progress = createProgress(document.getElementById('threads-progress'));
  progress.reset();
  try {
    const { summary } = await summarizeThread(buildPayload(thread, entries), readOutputLanguage('out-lang-summary'), progress.asCallback());
    await updateThreadSummary(thread.id, summary);
    toast(t('people.toast.summary_saved'), 'ok');
    // Re-render the whole threads panel so the list-line summary
    // ("Last activity … · <summary>") reflects the update. The re-render
    // removes the progress panel as a side effect.
    await renderThreads();
  } catch (err) {
    setInlineError('threads-error', t('people.error.summarize_failed', { err: err.message }));
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

const runGenerate = async (thread, entries, goal) => {
  const btnID = goal === 'outreach' ? 'btn-generate-outreach' : 'btn-generate-reply';
  const btn = document.getElementById(btnID);
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Drafting…</span>';
  setInlineError('threads-error', '');
  const progress = createProgress(document.getElementById('threads-progress'));
  progress.reset();
  try {
    const { message } = await generateMessage({ ...buildPayload(thread, entries), goal }, '', progress.asCallback());
    renderDraftPanel(thread.id, goal, message);
    progress.reset();
  } catch (err) {
    setInlineError('threads-error', t('people.error.draft_failed', { err: err.message }));
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

const renderDraftPanel = (threadID, goal, message) => {
  const panel = document.getElementById('draft-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = draftPanelHtml(goal, message);
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  document.getElementById('btn-discard-draft').addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  });
  document.getElementById('btn-save-draft').addEventListener('click', async () => {
    setInlineError('draft-error', '');
    const content = document.getElementById('draft-message').value.trim();
    if (!content) {
      setInlineError('draft-error', t('people.error.draft_empty'));
      return;
    }
    try {
      await createEntry({
        thread_id: threadID,
        direction: 'outbound',
        content,
      });
      toast(t('people.toast.draft_saved'), 'ok');
      panel.classList.add('hidden');
      panel.innerHTML = '';
      await renderThreadDetail(threadID);
    } catch (err) {
      setInlineError('draft-error', t('common.error.save_failed', { err: err.message }));
    }
  });
};

// ---------- entrypoint ----------
export const mountPeople = async (root) => {
  root.innerHTML = shellHtml();
  PANEL_IDS.forEach(rememberPanelAnchor);
  document.getElementById('btn-new').addEventListener('click', () => openEditor('new'));
  document.getElementById('people-search').addEventListener('input', (e) => {
    filterState.query = e.target.value;
    renderList();
  });

  // Resolve ?company_id=… before the first list render so the banner and
  // count reflect the filter from the very first paint.
  const params = new URLSearchParams(location.search);
  const rawCompanyID = Number(params.get('company_id'));
  if (rawCompanyID) {
    const company = await getCompany(rawCompanyID);
    if (company) companyFilter = { id: company.id, name: company.official_name };
    else toast(t('people.toast.company_missing_filter', { id: rawCompanyID }), 'warning');
  }

  await refreshList();

  // Auto-open the new-person editor if arriving via a quick-action link.
  if (params.get('new') === '1') openEditor('new');
};
