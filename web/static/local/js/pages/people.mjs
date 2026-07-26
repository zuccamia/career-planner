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
  listThreadsByPersonID, getThread, createThread, updateThreadStatus,
  updateThreadSummary, deleteThread, countThreadsByPersonID,
  listEntriesByThreadID, createEntry, deleteEntry,
} from '../entities/communications.mjs';
import { summarizeThread, generateMessage } from '../rpc.mjs';
import { escapeHtml, formatDate } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { badge, button, emptyState, inlineError, setInlineError, pageHeader, setPageCount } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { rememberPanelAnchor, mountInlinePanel, restoreAllPanels } from '../ui/panels.mjs';
import { refreshSidebarCounts } from '../ui/sidebar_counts.mjs';

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
const CHANNEL_ICONS = new Set(['email', 'handshake', 'linkedin', 'phone', 'meeting', 'text']);

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
  inbound:  { icon: 'arrowIn',  circle: 'bg-emerald-100 text-emerald-700', label: 'Inbound' },
  outbound: { icon: 'arrowOut', circle: 'bg-blue-100 text-blue-700',       label: 'Outbound' },
  note:     { icon: 'note',     circle: 'bg-slate-100 text-slate-600',     label: 'Note' },
};

const directionIcon = (direction) => {
  const style = DIRECTION_STYLES[direction] || DIRECTION_STYLES.note;
  return `<span class="inline-flex h-8 w-8 items-center justify-center rounded-full ${style.circle}" title="${style.label}" aria-label="${style.label}">
    ${icon(style.icon, 4)}
  </span>`;
};

const linkedInIconLink = (url) => url
  ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="LinkedIn" aria-label="LinkedIn"
        class="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-blue-700 transition">
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.59 0 4.26 2.36 4.26 5.43v6.31zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zm1.78 13.02H3.56V9h3.56v11.45z" />
      </svg>
    </a>`
  : '';

// ---------- markup ----------
const shellHtml = () => `
  <div class="space-y-6">
    <div id="toast" class="hidden"></div>

    <section class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      ${pageHeader({ title: 'People', countId: 'people-count' })}
      ${button({ id: 'btn-new', variant: 'primaryCompact', icon: 'plus', label: 'Person', ariaLabel: 'Add person' })}
    </section>

    <section id="editor-panel" class="hidden"></section>
    <section id="threads-panel" class="hidden"></section>

    <section id="list-panel" class="${CLS.card}">
      ${inlineError({ id: 'list-error' })}
      <div id="list-content"></div>
    </section>
  </div>
`;

const editorHtml = (person, companies) => {
  const isNew = !person;
  const p = person || {};
  const selectedCompany = isNew ? '' : String(p.company_id ?? '');
  const companyOptions = [
    `<option value="" ${selectedCompany ? '' : 'selected'}>— No company —</option>`,
    ...companies.map(c => `
      <option value="${c.id}" ${String(c.id) === selectedCompany ? 'selected' : ''}>
        ${escapeHtml(c.official_name)}
      </option>`),
  ].join('');
  return `
    <div class="${CLS.card}">
      <form id="editor-form" class="space-y-5">
        <div class="flex items-baseline justify-between">
          <p class="${CLS.eyebrow}">${isNew ? 'New person' : 'Edit'}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: isNew ? 'Create person' : 'Save changes' })}
            ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel' })}
          </div>
        </div>

        ${inlineError({ id: 'editor-error' })}

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:items-start">
          <div class="grid gap-2">
            <label class="${CLS.label}" for="full_name">Full name</label>
            <input id="full_name" name="full_name" type="text" required
                   value="${escapeHtml(p.full_name)}" placeholder="e.g. Ada Lovelace"
                   class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="title">Title</label>
            <input id="title" name="title" type="text"
                   value="${escapeHtml(p.title)}" placeholder="e.g. Engineering Manager"
                   class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="company_id">Company</label>
            <select id="company_id" name="company_id" class="${CLS.select}">
              ${companyOptions}
            </select>
            <p class="text-xs text-slate-500">
              Optional. <a href="/local/companies?new=1" class="text-blue-700 underline hover:text-blue-800">Add a company</a> first if you need a new one.
            </p>
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="linkedin_url">LinkedIn URL</label>
            <input id="linkedin_url" name="linkedin_url" type="url"
                   value="${escapeHtml(p.linkedin_url)}" placeholder="https://linkedin.com/in/…"
                   class="${CLS.input}">
          </div>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="notes">Notes</label>
          <textarea id="notes" name="notes" rows="4" class="${CLS.textarea}"
                    placeholder="Background context, shared interests, past conversations…">${escapeHtml(p.notes)}</textarea>
          <p class="text-xs text-slate-500">
            These notes feed the LLM when summarizing threads or drafting messages, so the more grounded detail here, the better.
          </p>
        </div>
      </form>
    </div>
  `;
};

const listHtml = (people, threadCounts) => {
  if (!people.length) {
    return emptyState({ message: 'No people yet.' });
  }
  return `
    <ul class="space-y-3">
      ${people.map(p => {
        const count = threadCounts.get(p.id) ?? 0;
        return `
          <li data-panel-row="${p.id}">
            <div class="block rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 transition hover:border-blue-200 hover:bg-blue-50/40">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div class="space-y-2 min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold text-slate-900">${escapeHtml(p.full_name)}</span>
                    ${linkedInIconLink(p.linkedin_url)}
                    ${count > 0 ? badge({ color: 'blue', size: 'xs', label: `${count} thread${count === 1 ? '' : 's'}` }) : ''}
                  </div>
                  ${p.title || p.company_name ? `
                    <p class="text-sm text-slate-600">
                      ${escapeHtml(p.title)}${p.title && p.company_name ? ' · ' : ''}${escapeHtml(p.company_name)}
                    </p>` : ''}
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-sm text-slate-500">Updated ${formatDate(p.updated_at)}</span>
                  ${button({ variant: 'secondaryCompact', label: 'Threads', extraClass: 'js-threads', dataset: { id: p.id } })}
                  ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: 'Edit person', extraClass: 'js-edit', dataset: { id: p.id } })}
                  ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: `Delete ${p.full_name}`, extraClass: 'js-delete', dataset: { id: p.id, name: p.full_name } })}
                </div>
              </div>
            </div>
          </li>`;
      }).join('')}
    </ul>`;
};

// ---------- threads panel ----------

const threadsHeaderHtml = (person) => `
  <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
    <div class="space-y-1">
      <p class="${CLS.eyebrow}">Threads — ${escapeHtml(person.full_name)}</p>
      <p class="text-xs text-slate-500">
        Conversations, notes, and drafted messages for this person.
        ${person.notes ? 'Background notes on the person feed the LLM automatically.' : 'Add notes on the person to give the LLM more context.'}
      </p>
    </div>
    <div class="flex flex-nowrap items-center gap-2 shrink-0">
      ${button({ id: 'btn-new-thread', icon: 'plus', variant: 'primaryCompact', label: 'Thread', ariaLabel: 'Add thread' })}
      ${button({ id: 'btn-threads-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Close' })}
    </div>
  </div>
  ${inlineError({ id: 'threads-error' })}
`;

const newThreadFormHtml = () => `
  <form id="new-thread-form" class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <div class="flex items-baseline justify-between">
      <p class="${CLS.eyebrow}">New thread</p>
      <div class="flex items-center gap-2">
        ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: 'Create thread' })}
        ${button({ id: 'btn-cancel-new-thread', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel new thread' })}
      </div>
    </div>
    ${inlineError({ id: 'new-thread-error' })}
    <div class="grid gap-3 sm:grid-cols-3">
      <div class="grid gap-1 sm:col-span-2">
        <label class="${CLS.label}" for="new_thread_subject">Subject</label>
        <input id="new_thread_subject" name="subject" type="text" required
               class="${CLS.input}" placeholder="e.g. Intro chat re: intern program">
      </div>
      <div class="grid gap-1">
        <label class="${CLS.label}" for="new_thread_channel">Channel</label>
        <select id="new_thread_channel" name="channel" class="${CLS.select}">
          ${COMMUNICATION_CHANNELS.map(c => `<option value="${c}">${titleCase(c)}</option>`).join('')}
        </select>
      </div>
    </div>
  </form>
`;

const threadListHtml = (threads, openThreadID) => {
  if (!threads.length) {
    return `<p class="rounded-2xl bg-slate-50 px-4 py-4 text-sm text-slate-500">
      No threads yet. Create one to start tracking a conversation.
    </p>`;
  }
  return `
    <ul class="space-y-3">
      ${threads.map(t => {
        const expanded = t.id === openThreadID;
        return `
          <li>
            <div class="rounded-2xl border border-slate-200 bg-white p-4 ${expanded ? 'ring-1 ring-blue-200' : ''}">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div class="space-y-1 min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    ${channelBadge(t.channel)}
                    ${badge({ color: t.status === 'open' ? 'emerald' : 'slate', size: 'xs', label: titleCase(t.status) })}
                    <span class="font-semibold text-slate-900">${escapeHtml(t.subject) || '<span class="italic text-slate-400">Untitled thread</span>'}</span>
                  </div>
                  <p class="text-sm text-slate-500">
                    Last activity ${formatDate(t.last_activity_at)}
                    ${t.summary ? ` · ${escapeHtml(t.summary)}` : ''}
                  </p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  ${button({ variant: 'secondaryCompact', label: expanded ? 'Hide' : 'Open', extraClass: 'js-toggle-thread', dataset: { id: t.id } })}
                  ${button({
                    variant: 'icon',
                    icon: t.status === 'open' ? 'linkSlash' : 'link',
                    iconOnly: true,
                    ariaLabel: t.status === 'open' ? 'Close thread' : 'Reopen thread',
                    extraClass: 'js-toggle-status',
                    dataset: { id: t.id, status: t.status },
                  })}
                  ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: `Delete thread ${t.subject}`, extraClass: 'js-delete-thread', dataset: { id: t.id, subject: t.subject } })}
                </div>
              </div>
              ${expanded ? `<div id="thread-detail-${t.id}" class="mt-4 border-t border-slate-100 pt-4"></div>` : ''}
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
    <li class="flex items-start gap-3 rounded-xl bg-slate-50 px-3 py-2">
      <div class="shrink-0">
        ${directionIcon(e.direction)}
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-xs text-slate-500">${formatDate(e.occurred_at)}</p>
        <p class="js-entry-content ${collapsible ? 'line-clamp-1' : 'whitespace-pre-wrap'} text-sm text-slate-800"
           data-collapsed="${collapsible ? '1' : '0'}">${escapeHtml(e.content)}</p>
        ${collapsible ? `<button type="button" class="js-toggle-entry mt-1 text-xs font-medium text-blue-700 hover:text-blue-800" data-id="${e.id}">more</button>` : ''}
      </div>
      ${button({
        variant: 'dangerIcon', icon: 'trash', iconOnly: true,
        ariaLabel: 'Delete entry', extraClass: 'js-delete-entry',
        dataset: { id: e.id },
      })}
    </li>
  `;
};

const threadDetailHtml = (thread, entries) => `
  <div class="space-y-4">
    <div class="flex flex-wrap gap-2">
      ${button({ id: 'btn-new-entry', variant: 'primaryCompact', icon: 'plus', label: 'Entry', ariaLabel: 'Add entry' })}
      ${button({ id: 'btn-summarize', variant: 'secondaryCompact', icon: 'sparkles', label: thread.summary ? 'Resummarize' : 'Summarize' })}
      ${button({ id: 'btn-generate-outreach', variant: 'secondaryCompact', icon: 'sparkles', label: 'Draft outreach' })}
      ${button({ id: 'btn-generate-reply', variant: 'secondaryCompact', icon: 'sparkles', label: 'Draft reply' })}
    </div>

    <div id="draft-panel" class="hidden"></div>

    <div id="new-entry-container"></div>

    ${entries.length ? `
      <ul class="space-y-2">${entries.map(entryHtml).join('')}</ul>
    ` : `
      <p class="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-500">
        No entries yet. Add the first message or note above.
      </p>
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
  <form id="new-entry-form" class="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
    <div class="flex items-baseline justify-between">
      <p class="${CLS.eyebrow}">New entry</p>
      <div class="flex items-center gap-2">
        ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: 'Create entry' })}
        ${button({ id: 'btn-cancel-new-entry', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel new entry' })}
      </div>
    </div>
    ${inlineError({ id: 'new-entry-error' })}
    <div class="grid gap-3 sm:grid-cols-2 sm:items-start">
      <div class="grid gap-1">
        <label class="${CLS.label}" for="entry_direction">Direction</label>
        <select id="entry_direction" name="direction" class="${CLS.select}">
          ${COMMUNICATION_DIRECTIONS.map(d => `<option value="${d}">${titleCase(d)}</option>`).join('')}
        </select>
      </div>
      <div class="grid gap-1">
        <label class="${CLS.label}" for="entry_occurred_at">Occurred at</label>
        <input id="entry_occurred_at" name="occurred_at" type="date"
               value="${todayLocalDate()}" class="${CLS.input}">
      </div>
    </div>
    <div class="grid gap-1">
      <label class="${CLS.label}" for="entry_content">Content</label>
      <textarea id="entry_content" name="content" rows="3" required class="${CLS.textarea}"
                placeholder="What was said, or your private note."></textarea>
    </div>
  </form>
`;

const draftPanelHtml = (goal, message) => `
  <div class="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-3">
    <div class="flex items-baseline justify-between">
      <p class="${CLS.eyebrow}">Draft (${escapeHtml(goal)})</p>
      <div class="flex items-center gap-2">
        ${button({ id: 'btn-save-draft', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: 'Save as outbound entry' })}
        ${button({ id: 'btn-discard-draft', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Discard draft' })}
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
  ? `<div class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-900">
       <span>Filtered by company: <span class="font-semibold">${escapeHtml(companyFilter.name)}</span></span>
       <a href="/local/people" class="font-semibold text-blue-700 underline hover:text-blue-800">Clear filter</a>
     </div>`
  : '';

// ---------- list handlers ----------
const refreshList = async () => {
  const all = await listPeople();
  const people = companyFilter
    ? all.filter(p => p.company_id === companyFilter.id)
    : all;
  const counts = new Map();
  await Promise.all(people.map(async (p) => {
    counts.set(p.id, await countThreadsByPersonID(p.id));
  }));
  restoreAllPanels(PANEL_IDS);
  document.getElementById('list-content').innerHTML = filterBannerHtml() + listHtml(people, counts);
  if (editorMode && editorMode !== 'new') mountInlinePanel('editor-panel', editorMode.id);
  if (openThreadsPerson) mountInlinePanel('threads-panel', openThreadsPerson.id);
  setPageCount('people-count', people.length, n => companyFilter
    ? `${n} ${n === 1 ? 'person' : 'people'} at ${companyFilter.name}.`
    : `${n} ${n === 1 ? 'person' : 'people'} tracked locally.`);
  refreshSidebarCounts().catch(() => {});
  document.querySelectorAll('.js-edit').forEach(btn =>
    btn.addEventListener('click', () => openEditor({ id: Number(btn.dataset.id) })));
  document.querySelectorAll('.js-threads').forEach(btn =>
    btn.addEventListener('click', () => openThreads(Number(btn.dataset.id))));
  document.querySelectorAll('.js-delete').forEach(btn =>
    btn.addEventListener('click', () => deletePersonFromList(Number(btn.dataset.id), btn.dataset.name)));
};

const deletePersonFromList = async (personID, name) => {
  if (!confirm(`Delete "${name}"? This also removes all their communication threads and entries. Applications linked to this person will block the delete.`)) return;
  setInlineError('list-error', '');
  try {
    await deletePerson(personID);
    if (editorMode && editorMode !== 'new' && editorMode.id === personID) closeEditor();
    if (openThreadsPerson && openThreadsPerson.id === personID) closeThreads();
    toast('Person deleted', 'ok');
    await refreshList();
  } catch (err) {
    setInlineError('list-error', `Delete failed: ${err.message}. Delete linked applications first.`);
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
      toast(`Person #${mode.id} not found`, 'error');
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
    linkedin_url: (fd.get('linkedin_url') || '').toString().trim(),
    notes: (fd.get('notes') || '').toString(),
  };
};

const wireEditor = () => {
  const form = document.getElementById('editor-form');
  document.getElementById('btn-cancel').addEventListener('click', closeEditor);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setInlineError('editor-error', '');
    const data = readEditorForm(form);
    if (!data.full_name) {
      setInlineError('editor-error', 'Full name is required');
      return;
    }
    try {
      if (editorMode === 'new') {
        const existing = await findPersonByName(data.full_name);
        if (existing) {
          setInlineError('editor-error', `Person "${data.full_name}" already exists (#${existing.id})`);
          return;
        }
        const id = await createPerson(data);
        toast(`Created person #${id}`, 'ok');
      } else {
        await updatePerson(editorMode.id, data);
        toast('Person saved', 'ok');
      }
      closeEditor();
      await refreshList();
    } catch (err) {
      setInlineError('editor-error', `Save failed: ${err.message}`);
    }
  });
};

// ---------- threads panel ----------
const openThreads = async (personID) => {
  closeEditor();
  const person = await getPerson(personID);
  if (!person) {
    toast(`Person #${personID} not found`, 'error');
    return;
  }
  openThreadsPerson = person;
  openThreadID = null;
  const panel = document.getElementById('threads-panel');
  panel.classList.remove('hidden');
  await renderThreads();
  mountInlinePanel('threads-panel', personID);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const closeThreads = () => {
  openThreadsPerson = null;
  openThreadID = null;
  mountInlinePanel('threads-panel', null);
  const panel = document.getElementById('threads-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
};

const renderThreads = async () => {
  if (!openThreadsPerson) return;
  const panel = document.getElementById('threads-panel');
  const threads = await listThreadsByPersonID(openThreadsPerson.id);
  panel.innerHTML = `
    <div class="${CLS.card}">
      ${threadsHeaderHtml(openThreadsPerson)}
      <div id="new-thread-container"></div>
      <div id="thread-list">${threadListHtml(threads, openThreadID)}</div>
    </div>
  `;
  wireThreadsPanel();
  // Expand the currently open thread's detail (if any).
  if (openThreadID) await renderThreadDetail(openThreadID);
};

const wireThreadsPanel = () => {
  document.getElementById('btn-threads-close').addEventListener('click', closeThreads);
  document.getElementById('btn-new-thread').addEventListener('click', openNewThreadForm);

  document.querySelectorAll('.js-toggle-thread').forEach(btn =>
    btn.addEventListener('click', () => toggleThread(Number(btn.dataset.id))));
  document.querySelectorAll('.js-toggle-status').forEach(btn =>
    btn.addEventListener('click', () => toggleThreadStatus(Number(btn.dataset.id), btn.dataset.status)));
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
      setInlineError('new-thread-error', 'Subject is required');
      return;
    }
    try {
      const id = await createThread({
        person_id: openThreadsPerson.id,
        subject,
        channel: fd.get('channel'),
        status: 'open',
      });
      toast(`Thread #${id} created`, 'ok');
      openThreadID = id;
      await renderThreads();
      await refreshList();
    } catch (err) {
      setInlineError('new-thread-error', `Create thread failed: ${err.message}`);
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
    toast(`Thread ${next}`, 'ok');
    await renderThreads();
  } catch (err) {
    setInlineError('threads-error', `Status change failed: ${err.message}`);
  }
};

const deleteThreadFromList = async (threadID, subject) => {
  if (!confirm(`Delete thread "${subject}"? All entries under it are removed too.`)) return;
  setInlineError('threads-error', '');
  try {
    await deleteThread(threadID);
    if (openThreadID === threadID) openThreadID = null;
    toast('Thread deleted', 'ok');
    await renderThreads();
    await refreshList();
  } catch (err) {
    setInlineError('threads-error', `Delete failed: ${err.message}`);
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
      setInlineError('new-entry-error', 'Entry content is required');
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
      toast('Entry added', 'ok');
      await renderThreadDetail(thread.id);
    } catch (err) {
      setInlineError('new-entry-error', `Add entry failed: ${err.message}`);
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
    btn.textContent = 'less';
  } else {
    contentEl.classList.add('line-clamp-1');
    contentEl.classList.remove('whitespace-pre-wrap');
    contentEl.dataset.collapsed = '1';
    btn.textContent = 'more';
  }
};

const deleteEntryFromDetail = async (threadID, entryID) => {
  if (!confirm('Delete this entry?')) return;
  setInlineError('threads-error', '');
  try {
    await deleteEntry(entryID);
    toast('Entry deleted', 'ok');
    await renderThreadDetail(threadID);
  } catch (err) {
    setInlineError('threads-error', `Delete entry failed: ${err.message}`);
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
  try {
    const { summary } = await summarizeThread(buildPayload(thread, entries));
    await updateThreadSummary(thread.id, summary);
    toast('Summary saved', 'ok');
    // Re-render the whole threads panel so the list-line summary
    // ("Last activity … · <summary>") reflects the update.
    await renderThreads();
  } catch (err) {
    setInlineError('threads-error', `Summarize failed: ${err.message}`);
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
  try {
    const { message } = await generateMessage({ ...buildPayload(thread, entries), goal });
    renderDraftPanel(thread.id, goal, message);
  } catch (err) {
    setInlineError('threads-error', `Draft failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

const renderDraftPanel = (threadID, goal, message) => {
  const panel = document.getElementById('draft-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = draftPanelHtml(goal, message);

  document.getElementById('btn-discard-draft').addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  });
  document.getElementById('btn-save-draft').addEventListener('click', async () => {
    setInlineError('draft-error', '');
    const content = document.getElementById('draft-message').value.trim();
    if (!content) {
      setInlineError('draft-error', 'Draft is empty');
      return;
    }
    try {
      await createEntry({
        thread_id: threadID,
        direction: 'outbound',
        content,
      });
      toast('Draft saved as outbound entry', 'ok');
      panel.classList.add('hidden');
      panel.innerHTML = '';
      await renderThreadDetail(threadID);
    } catch (err) {
      setInlineError('draft-error', `Save failed: ${err.message}`);
    }
  });
};

// ---------- entrypoint ----------
export const mountPeople = async (root) => {
  root.innerHTML = shellHtml();
  PANEL_IDS.forEach(rememberPanelAnchor);
  document.getElementById('btn-new').addEventListener('click', () => openEditor('new'));

  // Resolve ?company_id=… before the first list render so the banner and
  // count reflect the filter from the very first paint.
  const params = new URLSearchParams(location.search);
  const rawCompanyID = Number(params.get('company_id'));
  if (rawCompanyID) {
    const company = await getCompany(rawCompanyID);
    if (company) companyFilter = { id: company.id, name: company.official_name };
    else toast(`Company #${rawCompanyID} not found — showing all people`, 'warning');
  }

  await refreshList();

  // Auto-open the new-person editor if arriving via a quick-action link.
  if (params.get('new') === '1') openEditor('new');
};
