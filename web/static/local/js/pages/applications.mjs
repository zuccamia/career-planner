// Applications page: list + inline editor + inline details panel. The details
// panel mirrors the company research panel — it drops in above the list,
// replaces the editor if that's open, and holds the parsed job description,
// timeline events, and raw JD accordion. Companies are managed on a separate
// page; applications reference them via a dropdown so the FK invariant is
// explicit.

import {
  APPLICATION_STATUSES,
  listApplications, getApplication,
  createApplication, updateApplication, updateApplicationStatus,
  deleteApplication, updateApplicationExtraction,
  listEventsByApplication, clearAllApplications,
} from '../entities/applications.mjs';
import {
  listAttachmentsByParent, createAttachment, deleteAttachment,
} from '../entities/attachments.mjs';
import {
  sanitizeFolder, uploadAttachment, downloadAttachment,
} from '../storage/attachments.mjs';
import { listCompanies, getCompany } from '../entities/companies.mjs';
import { listPeopleByCompanyID } from '../entities/people.mjs';
import { escapeHtml, formatDate, formatBytes } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { badge, badgeClasses, button, collapsible, emptyState, inlineError, setInlineError, inlineNote, setInlineNote, pageHeader, setPageCount } from '../ui/components.mjs';
import { extractJobDescription } from '../rpc.mjs';
import { rememberPanelAnchor, mountInlinePanel, restoreAllPanels } from '../ui/panels.mjs';
import { refreshSidebarCounts } from '../ui/sidebar_counts.mjs';

const PANEL_IDS = ['editor-panel', 'details-panel'];

// "online_assessment" -> "Online assessment"
const humanize = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '';

// Status → badge palette. Matches internal/http/render.go applicationStatusClasses
// so pills look identical between the legacy and local surfaces.
const STATUS_BADGE_COLOR = {
  wishlist: 'slate',
  applied: 'blue',
  online_assessment: 'cyan',
  first_interview: 'amber',
  second_interview: 'orange',
  additional_interview: 'fuchsia',
  offer: 'emerald',
  rejected: 'rose',
  withdrawn: 'violet',
};

const formatSalary = (currency, amount) => {
  const amt = (amount || '').trim();
  if (!amt) return '';
  const cur = (currency || '').trim().toUpperCase();
  const symbol = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[cur] || cur;
  if (!symbol) return amt;
  const numeric = /^[0-9]/.test(amt);
  return numeric ? `${symbol}${amt}` : `${amt} ${symbol}`.trim();
};

const parseStructured = (jsonText) => {
  const trimmed = (jsonText || '').trim();
  if (!trimmed || trimmed === '{}') return { ok: true, data: null };
  try { return { ok: true, data: JSON.parse(trimmed) }; }
  catch (err) { return { ok: false, data: null, error: err.message }; }
};

// eventSummary mirrors internal/http/render.go applicationEventSummary so the
// timeline reads the same on both surfaces.
const eventSummary = (ev) => {
  const type = (ev.type || '').trim().toLowerCase();
  const content = (ev.content || '').trim();
  const from = (ev.from_status || '').trim();
  const to = (ev.to_status || '').trim();
  if (type === 'status_changed') {
    if (from && to) {
      return content
        ? `Status changed: ${humanize(from)} → ${humanize(to)} — ${content}`
        : `Status changed: ${humanize(from)} → ${humanize(to)}`;
    }
    if (to) {
      return content
        ? `Status changed: ${humanize(to)} — ${content}`
        : `Status changed: ${humanize(to)}`;
    }
    return content || 'Status changed';
  }
  if (type === 'created') {
    if (content) return content;
    if (to) return `Application created: ${humanize(to)}`;
    return 'Application created';
  }
  if (content) return content;
  if (to) return from ? `${humanize(from)} → ${humanize(to)}` : humanize(to);
  return humanize(type);
};

// ---------- markup: shell + editor + list ----------

const shellHtml = () => `
  <div class="space-y-6">
    <div id="toast" class="hidden"></div>

    <section class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      ${pageHeader({ title: 'Application tracker', countId: 'app-count' })}
      ${button({ id: 'btn-new', variant: 'primaryCompact', icon: 'plus', label: 'Application', ariaLabel: 'Add application' })}
    </section>

    <section id="editor-panel" class="hidden"></section>
    <section id="details-panel" class="hidden"></section>

    <section id="list-panel" class="${CLS.card}">
      ${inlineError({ id: 'list-error' })}
      <div id="list-content"></div>
    </section>
  </div>
`;

const noCompaniesHtml = () => `
  <div class="${CLS.card}">
    <div class="flex items-baseline justify-between">
      <p class="${CLS.eyebrow}">Add a company first</p>
      ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel' })}
    </div>
    <p class="text-sm text-slate-600">
      Applications reference companies via foreign key, so at least one company row has to exist first.
      Head to the Companies page to add one — the LLM "Look up" affordance there can populate the fields for you.
    </p>
    ${button({ kind: 'link', href: '/local/companies?new=1', icon: 'plus', label: 'Add a company' })}
  </div>
`;

// personOptions renders the <option>s inside the person dropdown. Broken out
// so we can rebuild it in place when the selected company changes without
// re-rendering the whole editor.
const personOptions = (people, selectedID) => [
  `<option value="">— No contact —</option>`,
  ...people.map(p => `
    <option value="${p.id}" ${String(p.id) === String(selectedID ?? '') ? 'selected' : ''}>
      ${escapeHtml(p.full_name)}${p.title ? ` — ${escapeHtml(p.title)}` : ''}
    </option>`),
].join('');

const editorHtml = (app, companies, people) => {
  const isNew = !app;
  const a = app || {};
  const status = a.status || 'wishlist';
  const selectedCompany = isNew ? '' : String(a.company_id ?? '');
  const companyOptions = [
    `<option value="" disabled ${selectedCompany ? '' : 'selected'}>Select a company…</option>`,
    ...companies.map(c => `
      <option value="${c.id}" ${String(c.id) === selectedCompany ? 'selected' : ''}>
        ${escapeHtml(c.official_name)}
      </option>`),
  ].join('');
  return `
    <div class="${CLS.card}">
      <form id="editor-form" class="space-y-5">
        <div class="flex items-baseline justify-between">
          <p class="${CLS.eyebrow}">${isNew ? 'New application' : 'Edit'}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: isNew ? 'Create application' : 'Save changes' })}
            ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel' })}
          </div>
        </div>

        ${inlineError({ id: 'editor-error' })}

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:items-start">
          <div class="grid gap-2">
            <label class="${CLS.label}" for="company_id">Company</label>
            <select id="company_id" name="company_id" required class="${CLS.select}">
              ${companyOptions}
            </select>
            <p class="text-xs text-slate-500">
              Need a new company? <a href="/local/companies?new=1" class="text-blue-700 underline hover:text-blue-800">Add one</a>.
            </p>
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="role_title">Role</label>
            <input id="role_title" name="role_title" type="text" required
                   value="${escapeHtml(a.role_title)}" placeholder="e.g. Software Engineer"
                   class="${CLS.input}">
          </div>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="person_id">Point of contact</label>
          <select id="person_id" name="person_id" class="${CLS.select}">
            ${personOptions(people, a.person_id)}
          </select>
          <p class="text-xs text-slate-500">
            People scoped to the selected company. Manage contacts on the
            <a href="/local/people" class="text-blue-700 underline hover:text-blue-800">People page</a>.
          </p>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="job_posting_url">Job posting URL</label>
          <input id="job_posting_url" name="job_posting_url" type="url"
                 value="${escapeHtml(a.job_posting_url)}" placeholder="https://…"
                 class="${CLS.input}">
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="status">Status</label>
          <select id="status" name="status" class="${CLS.select}">
            ${APPLICATION_STATUSES.map(s => `
              <option value="${s}" ${s === status ? 'selected' : ''}>${humanize(s)}</option>
            `).join('')}
          </select>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="job_description_raw">Job description</label>
          <textarea id="job_description_raw" name="job_description_raw" rows="8"
                    class="${CLS.textarea} font-mono"
                    placeholder="Paste the JD, or click Extract on the details panel to fetch from the posting URL.">${escapeHtml(a.job_description_raw)}</textarea>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="notes">Notes</label>
          <textarea id="notes" name="notes" rows="3" class="${CLS.textarea}">${escapeHtml(a.notes)}</textarea>
        </div>
      </form>
    </div>
  `;
};

const listHtml = (apps) => {
  if (!apps.length) {
    return emptyState({ message: 'No applications yet.' });
  }
  return `
    <ul class="space-y-3">
      ${apps.map(a => {
        const pillClass = badgeClasses(STATUS_BADGE_COLOR[a.status] || 'slate', 'xs');
        const url = escapeHtml(a.job_posting_url);
        const roleLabel = escapeHtml(a.role_title) || '<span class="italic text-slate-400">Untitled role</span>';
        // Role title is a hyperlink to the posting when we have a URL,
        // otherwise falls back to opening the inline details panel.
        const roleEl = a.job_posting_url
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="font-semibold text-slate-900 hover:text-blue-700 hover:underline">${roleLabel}</a>`
          : `<button type="button" class="js-details bg-transparent p-0 text-left font-semibold text-slate-900 hover:text-blue-700 hover:underline" data-id="${a.id}">${roleLabel}</button>`;
        return `
          <li data-panel-row="${a.id}">
            <div class="block rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 transition hover:border-blue-200 hover:bg-blue-50/40">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div class="space-y-2 min-w-0">
                  ${roleEl}
                  <p class="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                    <span>${escapeHtml(a.company_name) || '<span class="italic text-slate-400">Unknown company</span>'}${a.person_name ? ` · ${escapeHtml(a.person_name)}` : ''}</span>
                    <span class="${pillClass}">${escapeHtml(humanize(a.status))}</span>
                  </p>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-sm text-slate-500">Updated ${formatDate(a.updated_at)}</span>
                  ${button({ variant: 'secondaryCompact', label: 'View', extraClass: 'js-details', dataset: { id: a.id } })}
                  ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: 'Edit application', extraClass: 'js-edit', dataset: { id: a.id } })}
                  ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: `Delete ${a.role_title || 'application'}`, extraClass: 'js-delete', dataset: { id: a.id, label: a.role_title || `#${a.id}` } })}
                </div>
              </div>
            </div>
          </li>`;
      }).join('')}
    </ul>
    <div class="mt-6 flex justify-end border-t border-slate-100 pt-4">
      ${button({ id: 'btn-clear-all', variant: 'dangerCompact', icon: 'trash', label: 'Clear all applications' })}
    </div>`;
};

// ---------- markup: details panel ----------

const chips = (items, color) => (items || [])
  .map(item => `<span class="${badgeClasses(color, 'sm')} mb-2 mr-2">${escapeHtml(item)}</span>`)
  .join('');

const bulletList = (items) => `
  <ul class="list-disc space-y-2 pl-5 text-sm text-slate-700">
    ${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
  </ul>`;

const emptyLine = (msg) => `<p class="text-sm text-slate-500">${escapeHtml(msg)}</p>`;

const structuredHtml = (parsed) => {
  if (!parsed.ok) {
    return `<div class="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      Structured job description could not be loaded. Re-extract to replace the saved data.
    </div>`;
  }
  const s = parsed.data;
  if (!s) {
    return emptyState({ message: 'No structured job description yet.' });
  }
  const req = s.requirements || {};
  const salaryLabel = formatSalary(s.salary?.currency, s.salary?.amount);
  const hasDeadline = !!(s.application_deadline || '').trim();
  const hasSalary = !!salaryLabel;
  const anyBadge = s.role_level || s.employment_type || s.season || (s.year > 0) || hasDeadline || hasSalary;
  return `
    <div class="space-y-6">
      <section class="space-y-4">
        <div class="flex flex-wrap gap-2">
          ${s.role_level ? badge({ label: humanize(s.role_level), color: 'violet' }) : ''}
          ${s.employment_type ? badge({ label: humanize(s.employment_type), color: 'blue' }) : ''}
          ${s.season
            ? badge({ label: `${humanize(s.season)}${s.year > 0 ? ' ' + s.year : ''}`, color: 'emerald' })
            : (s.year > 0 ? badge({ label: String(s.year), color: 'emerald' }) : '')}
          ${hasDeadline ? badge({ label: s.application_deadline, color: 'rose' }) : ''}
          ${hasSalary ? badge({ label: salaryLabel, color: 'amber' }) : ''}
          ${!anyBadge ? '<span class="text-slate-500">No normalized role metadata identified.</span>' : ''}
        </div>
        <div class="grid gap-1">
          <dt class="text-sm font-semibold text-slate-500">Summary</dt>
          <dd>${(s.summary || '').trim() ? escapeHtml(s.summary) : '<span class="text-slate-500">No summary yet.</span>'}</dd>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-3">
          <h3 class="text-base font-semibold text-slate-900">Minimum qualifications</h3>
          ${(s.minimum_qualifications || []).length ? bulletList(s.minimum_qualifications) : emptyLine('No minimum qualifications identified.')}
        </div>
        <div class="space-y-3">
          <h3 class="text-base font-semibold text-slate-900">Preferred qualifications</h3>
          ${(s.preferred_qualifications || []).length ? bulletList(s.preferred_qualifications) : emptyLine('No preferred qualifications identified.')}
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-3">
          <h3 class="text-base font-semibold text-slate-900">Responsibilities</h3>
          ${(s.responsibilities || []).length ? bulletList(s.responsibilities) : emptyLine('No responsibilities identified.')}
        </div>
        <div class="space-y-3">
          <h3 class="text-base font-semibold text-slate-900">Requirements</h3>
          <dl class="space-y-3">
            <div class="flex flex-wrap gap-2">
              ${req.transcript_required ? badge({ label: 'Transcript required', color: 'rose' }) : ''}
              ${chips(req.education, 'slate')}
              ${chips(req.majors, 'indigo')}
            </div>
            <div class="grid gap-1">
              <dt class="text-sm font-semibold text-slate-500">Work authorization</dt>
              <dd class="text-sm text-slate-700">${(req.work_authorization || '').trim() ? escapeHtml(req.work_authorization) : '<span class="text-slate-500">Not identified</span>'}</dd>
            </div>
            <div class="grid gap-1">
              <dt class="text-sm font-semibold text-slate-500">Availability</dt>
              <dd class="text-sm text-slate-700">${(req.availability || []).length
                ? `<div class="space-y-1">${req.availability.map(v => `<p>${escapeHtml(v)}</p>`).join('')}</div>`
                : '<span class="text-slate-500">Not identified</span>'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-3">
        <div class="space-y-3">
          <h3 class="text-base font-semibold text-slate-900">Languages</h3>
          <div>${(s.languages || []).length ? chips(s.languages, 'emerald') : '<span class="text-sm text-slate-500">Not identified</span>'}</div>
        </div>
        <div class="space-y-3">
          <h3 class="text-base font-semibold text-slate-900">Skills</h3>
          <div>${(s.skills || []).length ? chips(s.skills, 'emerald') : '<span class="text-sm text-slate-500">Not identified</span>'}</div>
        </div>
        <div class="space-y-3">
          <h3 class="text-base font-semibold text-slate-900">Domains</h3>
          <div>${(s.domains || []).length ? chips(s.domains, 'emerald') : '<span class="text-sm text-slate-500">Not identified</span>'}</div>
        </div>
      </section>

      <section class="space-y-3">
        <h3 class="text-base font-semibold text-slate-900">Logistics</h3>
        <dl class="grid gap-4 sm:grid-cols-2">
          <div class="grid gap-1 sm:col-span-2">
            <dt class="text-sm font-semibold text-slate-500">Locations</dt>
            <dd>${(s.locations || []).length ? chips(s.locations, 'blue') : '<span class="text-slate-500">Not identified</span>'}</dd>
          </div>
          <div class="grid gap-1 sm:col-span-2">
            <dt class="text-sm font-semibold text-slate-500">Location notes</dt>
            <dd>${(s.location_notes || '').trim() ? escapeHtml(s.location_notes) : '<span class="text-slate-500">No additional notes.</span>'}</dd>
          </div>
        </dl>
      </section>
    </div>
  `;
};

const attachmentCardHtml = (att) => {
  const nameBtn = button({
    variant: 'linkMuted',
    label: att.original_filename,
    extraClass: 'js-download-attachment !text-slate-900 hover:!text-blue-700 hover:underline font-semibold',
    ariaLabel: `Download ${att.original_filename}`,
    dataset: {
      id: att.id,
      folder: att.folder,
      filename: att.filename,
      original: att.original_filename,
      mime: att.mime_type,
    },
  });
  const deleteBtn = button({
    variant: 'dangerIcon',
    icon: 'trash',
    iconOnly: true,
    ariaLabel: `Delete attachment ${att.original_filename}`,
    extraClass: 'js-delete-attachment',
    dataset: { id: att.id },
  });
  return `
    <li class="rounded-2xl bg-slate-50 px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          ${nameBtn}
          <p class="mt-1 text-xs text-slate-500">
            <span class="break-all">${escapeHtml(att.folder)}/${escapeHtml(att.filename)}</span>
            <span class="mx-1">·</span>
            <span>${escapeHtml(formatBytes(att.size_bytes))}</span>
            ${att.mime_type ? `<span class="mx-1">·</span><span>${escapeHtml(att.mime_type)}</span>` : ''}
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">${deleteBtn}</div>
      </div>
    </li>
  `;
};

const attachmentsSectionHtml = (a, attachments) => {
  const folderPreview = sanitizeFolder(a.company_name);
  return `
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-lg font-semibold text-slate-900">Attachments</h3>
      </div>
      ${inlineError({ id: 'attachment-upload-error' })}
      <label class="${CLS.btnSecondaryCompact} cursor-pointer">
        <input id="attachment-upload-input" type="file" class="hidden">
        <span id="attachment-upload-label">Upload file</span>
      </label>
      <p class="text-xs text-slate-500">
        Saved to <code class="rounded bg-slate-100 px-1">attachments/${escapeHtml(folderPreview)}/</code>
        on every connected backend.
      </p>
      ${attachments.length
        ? `<ul class="space-y-3">${attachments.map(attachmentCardHtml).join('')}</ul>`
        : emptyState({ message: 'No attachments yet.' })}
    </div>
  `;
};

// Timeline renders the latest event always, and hides the rest behind a
// native <details> "more…" toggle. Events arrive sorted DESC by occurred_at
// (see listEventsByApplication) so events[0] is the latest.
const timelineEventHtml = (ev) => `
  <li class="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
    <span class="text-slate-500">${escapeHtml(formatDate(ev.occurred_at))}</span>
    <span aria-hidden="true"> — </span>
    <span>${escapeHtml(eventSummary(ev))}</span>
  </li>
`;

const timelineHtml = (events) => {
  const [latest, ...rest] = events;
  return `
    <ul class="space-y-3">${timelineEventHtml(latest)}</ul>
    ${rest.length ? collapsible({
      summary: `more (${rest.length}) …`,
      content: `<ul class="mt-3 space-y-3">${rest.map(timelineEventHtml).join('')}</ul>`,
    }) : ''}
  `;
};

const detailsHtml = (a, events, attachments) => {
  const status = a.status || 'wishlist';
  const pillClass = badgeClasses(STATUS_BADGE_COLOR[status] || 'slate');
  const url = escapeHtml(a.job_posting_url || '');
  const hasRaw = !!(a.job_description_raw || '').trim();
  const hasURL = !!(a.job_posting_url || '').trim();
  const parsed = parseStructured(a.job_description_extracted_json);
  const hasNotes = !!(a.notes || '').trim();
  const hasPerson = !!a.person_id;
  return `
    <div class="${CLS.card}">
      <div class="flex items-baseline justify-between gap-3">
        <p class="${CLS.eyebrow}">${escapeHtml(a.company_name) || 'Unknown company'}</p>
        <div class="flex items-center gap-2">
          ${hasRaw || hasURL ? button({ id: 'btn-details-extract', variant: 'secondaryCompact', icon: 'sparkles', label: 'Extract description' }) : ''}
          ${button({ id: 'btn-details-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Close' })}
        </div>
      </div>

      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="text-2xl font-semibold tracking-tight text-slate-900">
            ${hasURL
              ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="hover:text-blue-700 hover:underline">${escapeHtml(a.role_title) || '<span class="italic text-slate-400">Untitled role</span>'}</a>`
              : (escapeHtml(a.role_title) || '<span class="italic text-slate-400">Untitled role</span>')}
          </h2>
          <span class="${pillClass}">${escapeHtml(humanize(status))}</span>
        </div>
        ${a.person_name ? `<p class="text-slate-600">${escapeHtml(a.person_name)}</p>` : ''}
      </div>

      ${inlineError({ id: 'details-error' })}
      ${inlineNote({ id: 'details-note' })}

      <form id="quick-status-form" class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 pt-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end">
        <div class="grid gap-2">
          <label class="${CLS.label}" for="quick-status">Status</label>
          <select class="${CLS.select}" id="quick-status" name="status">
            ${APPLICATION_STATUSES.map(s => `
              <option value="${s}" ${s === status ? 'selected' : ''}>${humanize(s)}</option>
            `).join('')}
          </select>
        </div>
        <div class="grid gap-2">
          <label class="${CLS.label}" for="quick-occurred-at">Date</label>
          <input class="${CLS.input}" id="quick-occurred-at" name="occurred_at" type="date">
        </div>
        <div class="grid gap-2">
          <label class="${CLS.label}" for="quick-notes">Short notes</label>
          <input class="${CLS.input}" id="quick-notes" name="notes" type="text" maxlength="255" placeholder="Optional context for the timeline">
        </div>
        <div>
          ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: 'Update status' })}
        </div>
      </form>

      ${(hasPerson || hasNotes) ? `
        <dl class="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
          ${hasPerson ? `
            <div class="grid gap-1">
              <dt class="text-sm font-semibold text-slate-500">Point of contact</dt>
              <dd>${escapeHtml(a.person_name || `Person #${a.person_id}`)}</dd>
            </div>` : ''}
          <div class="grid gap-1 sm:col-span-2">
            <dt class="text-sm font-semibold text-slate-500">Notes</dt>
            <dd>${hasNotes ? escapeHtml(a.notes) : '<span class="text-slate-500">No notes yet.</span>'}</dd>
          </div>
        </dl>` : ''}

      <div class="space-y-3">
        <h3 class="text-lg font-semibold text-slate-900">Job description</h3>
        ${structuredHtml(parsed)}
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="space-y-3">
          <h3 class="text-lg font-semibold text-slate-900">Timeline</h3>
          ${events.length ? timelineHtml(events) : emptyState({ message: 'No application events yet.' })}
        </div>
        ${attachmentsSectionHtml(a, attachments)}
      </div>

      ${collapsible({
        title: 'Raw job description',
        summary: 'Show',
        openSummary: 'Hide',
        extraClass: 'rounded-2xl border border-slate-200 bg-slate-50 p-4',
        content: `<div class="mt-4">${hasRaw
          ? `<pre class="overflow-x-auto rounded-2xl bg-white p-4 text-sm whitespace-pre-wrap text-slate-700">${escapeHtml(a.job_description_raw)}</pre>`
          : `<div class="rounded-2xl bg-white px-4 py-6 text-center text-sm text-slate-500">No raw job description saved yet.</div>`}</div>`,
      })}
    </div>
  `;
};

// ---------- state + handlers ----------
let editorMode = null;    // null | 'new' | { id }
let editorSubject = null; // cached row loaded into the editor — used to
                          // preserve fields the form doesn't expose (extracted
                          // JD JSON, person_id) so saves don't wipe them.
let detailsID = null;     // null | number — id of the application shown in details panel
// Optional company_id filter (from ?company_id=… — set by company-card pill).
let companyFilter = null; // { id, name } | null

const filterBannerHtml = () => companyFilter
  ? `<div class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-900">
       <span>Filtered by company: <span class="font-semibold">${escapeHtml(companyFilter.name)}</span></span>
       <a href="/local/applications" class="font-semibold text-blue-700 underline hover:text-blue-800">Clear filter</a>
     </div>`
  : '';

const refreshList = async () => {
  const all = await listApplications();
  const apps = companyFilter
    ? all.filter(a => a.company_id === companyFilter.id)
    : all;
  restoreAllPanels(PANEL_IDS);
  document.getElementById('list-content').innerHTML = filterBannerHtml() + listHtml(apps);
  if (editorMode && editorMode !== 'new') mountInlinePanel('editor-panel', editorMode.id);
  if (detailsID) mountInlinePanel('details-panel', detailsID);
  setPageCount('app-count', apps.length, n => companyFilter
    ? `${n} application${n === 1 ? '' : 's'} at ${companyFilter.name}.`
    : `${n} application${n === 1 ? '' : 's'} tracked locally.`);
  refreshSidebarCounts().catch(() => {});
  document.querySelectorAll('.js-edit').forEach(btn =>
    btn.addEventListener('click', () => openEditor({ id: Number(btn.dataset.id) })));
  document.querySelectorAll('.js-details').forEach(btn =>
    btn.addEventListener('click', () => openDetails(Number(btn.dataset.id))));
  document.querySelectorAll('.js-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteApplicationFromList(Number(btn.dataset.id), btn.dataset.label)));
  document.getElementById('btn-clear-all')?.addEventListener('click', clearAllApplicationsFromList);
};

// Clear every application (and its events + attachment records) in one shot.
// Meant for starting a new time-period snapshot with the same longer-lived
// companies/people data intact.
const clearAllApplicationsFromList = async () => {
  const msg = 'Clear ALL applications?\n\n'
    + '• Deletes every application, its timeline events, and its attachment records\n'
    + '• Keeps companies, people, and communications untouched\n'
    + '• Attachment files on Drive/local disk are not deleted (they become orphaned)\n\n'
    + 'This cannot be undone from inside the app. Restore from a snapshot if you need to recover.';
  if (!confirm(msg)) return;
  setInlineError('list-error', '');
  try {
    if (editorMode) closeEditor();
    if (detailsID) closeDetails();
    const { deleted } = await clearAllApplications();
    toast(`Cleared ${deleted} application${deleted === 1 ? '' : 's'}.`, 'ok');
    await refreshList();
  } catch (err) {
    setInlineError('list-error', `Clear failed: ${err.message}`);
  }
};

const deleteApplicationFromList = async (id, label) => {
  if (!confirm(`Delete "${label}"? This will remove its timeline events and attachments.`)) return;
  setInlineError('list-error', '');
  try {
    await deleteApplication(id);
    if (editorMode && editorMode !== 'new' && editorMode.id === id) closeEditor();
    if (detailsID === id) closeDetails();
    toast('Application deleted', 'ok');
    await refreshList();
  } catch (err) {
    setInlineError('list-error', `Delete failed: ${err.message}`);
  }
};

const openEditor = async (mode) => {
  closeDetails();
  editorMode = mode;
  const panel = document.getElementById('editor-panel');
  panel.classList.remove('hidden');

  let app = null;
  if (mode !== 'new') {
    app = await getApplication(mode.id);
    if (!app) {
      toast(`Application #${mode.id} not found`, 'error');
      closeEditor();
      return;
    }
  }
  editorSubject = app;
  const companies = await listCompanies();
  if (!companies.length) {
    panel.innerHTML = noCompaniesHtml();
    document.getElementById('btn-cancel').addEventListener('click', closeEditor);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const initialCompanyID = app?.company_id ?? null;
  const people = initialCompanyID ? await listPeopleByCompanyID(initialCompanyID) : [];
  panel.innerHTML = editorHtml(app, companies, people);
  wireEditor();

  mountInlinePanel('editor-panel', mode === 'new' ? null : mode.id);
  panel.querySelector('select[name="company_id"]')?.focus();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const closeEditor = () => {
  editorMode = null;
  editorSubject = null;
  mountInlinePanel('editor-panel', null);
  const panel = document.getElementById('editor-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
};

const readForm = (form) => {
  const fd = new FormData(form);
  return {
    company_id: Number(fd.get('company_id')) || null,
    person_id: Number(fd.get('person_id')) || null,
    role_title: (fd.get('role_title') || '').toString().trim(),
    job_posting_url: (fd.get('job_posting_url') || '').toString().trim(),
    status: (fd.get('status') || 'wishlist').toString(),
    job_description_raw: (fd.get('job_description_raw') || '').toString(),
    notes: (fd.get('notes') || '').toString(),
  };
};

const wireEditor = () => {
  const form = document.getElementById('editor-form');
  document.getElementById('btn-cancel').addEventListener('click', closeEditor);

  // Repopulate the person dropdown whenever the company selection changes.
  // Clears the current selection to avoid leaving a mismatched contact.
  const companySelect = form.querySelector('select[name="company_id"]');
  const personSelect = form.querySelector('select[name="person_id"]');
  companySelect?.addEventListener('change', async () => {
    const cid = Number(companySelect.value) || null;
    const people = cid ? await listPeopleByCompanyID(cid) : [];
    personSelect.innerHTML = personOptions(people, null);
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setInlineError('editor-error', '');
    const data = readForm(form);
    if (!data.company_id || !data.role_title) {
      setInlineError('editor-error', 'Company and role are required');
      return;
    }
    try {
      if (editorMode === 'new') {
        const id = await createApplication(data);
        toast(`Created application #${id}`, 'ok');
      } else {
        // person_id + company_id + notes come from the form; job_description_extracted_json
        // isn't exposed here so preserve whatever the row already has.
        await updateApplication(editorMode.id, {
          ...data,
          job_description_extracted_json: editorSubject?.job_description_extracted_json ?? '{}',
        });
        toast('Application saved', 'ok');
        if (detailsID === editorMode.id) await renderDetails();
      }
      closeEditor();
      await refreshList();
    } catch (err) {
      setInlineError('editor-error', `Save failed: ${err.message}`);
    }
  });
};

// ---------- details panel ----------

const closeDetails = () => {
  detailsID = null;
  mountInlinePanel('details-panel', null);
  const panel = document.getElementById('details-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
};

const renderDetails = async () => {
  if (!detailsID) return;
  const app = await getApplication(detailsID);
  if (!app) {
    toast(`Application #${detailsID} not found`, 'error');
    closeDetails();
    return;
  }
  const [events, attachments] = await Promise.all([
    listEventsByApplication(detailsID),
    listAttachmentsByParent('application', detailsID),
  ]);
  const panel = document.getElementById('details-panel');
  panel.innerHTML = detailsHtml(app, events, attachments);
  wireDetails(app);
};

const openDetails = async (id) => {
  // Editor and details are mutually exclusive to keep focus clear.
  closeEditor();
  detailsID = id;
  const panel = document.getElementById('details-panel');
  panel.classList.remove('hidden');
  await renderDetails();
  mountInlinePanel('details-panel', id);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const wireDetails = (app) => {
  document.getElementById('btn-details-close').addEventListener('click', closeDetails);

  document.getElementById('quick-status-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const status = fd.get('status')?.toString() || '';
    const notes = fd.get('notes')?.toString().trim() || '';
    const dateStr = fd.get('occurred_at')?.toString() || '';
    // "YYYY-MM-DD" → local midnight, then ISO. new Date("YYYY-MM-DD")
    // would treat the input as UTC and shift the day for negative offsets.
    let occurred_at = null;
    if (dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      occurred_at = new Date(y, m - 1, d).toISOString();
    }
    setInlineError('details-error', '');
    try {
      const before = app.status;
      await updateApplicationStatus({ id: app.id, status, occurred_at, notes });
      toast(before === status ? 'Status unchanged' : `Status → ${humanize(status)}`, before === status ? 'warning' : 'ok');
      await renderDetails();
      await refreshList();
    } catch (err) {
      setInlineError('details-error', `Status update failed: ${err.message}`);
    }
  });

  const uploadInput = document.getElementById('attachment-upload-input');
  uploadInput?.addEventListener('change', (ev) => onAttachmentUpload(ev, app));
  document.querySelectorAll('.js-download-attachment').forEach(btn =>
    btn.addEventListener('click', () => downloadAttachmentFromDetails(btn)));
  document.querySelectorAll('.js-delete-attachment').forEach(btn =>
    btn.addEventListener('click', () => deleteAttachmentFromDetails(Number(btn.dataset.id))));

  const extractBtn = document.getElementById('btn-details-extract');
  extractBtn?.addEventListener('click', async () => {
    extractBtn.disabled = true;
    extractBtn.setAttribute('aria-busy', 'true');
    setInlineError('details-error', '');
    setInlineNote('details-note', '');
    try {
      const resp = await extractJobDescription({
        company_name: app.company_name || '',
        role_title: app.role_title || '',
        job_posting_url: app.job_posting_url || '',
        job_description_raw: app.job_description_raw || '',
      });
      await updateApplicationExtraction(app.id, {
        structuredJson: JSON.stringify(resp.structured || {}),
        jobDescriptionRaw: resp.job_description_raw || '',
      });
      const reason = (resp.structured?.reasoning || '').trim();
      await renderDetails();
      // renderDetails re-renders the panel; re-apply the note after paint.
      setInlineNote('details-note', reason ? `Job description extracted. ${reason}` : 'Job description extracted');
    } catch (err) {
      setInlineError('details-error', `Extract failed: ${err.message}`);
      extractBtn.disabled = false;
      extractBtn.removeAttribute('aria-busy');
    }
  });
};

// ---------- attachment affordances ----------

const onAttachmentUpload = async (ev, app) => {
  const input = ev.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  const label = document.getElementById('attachment-upload-label');
  const prevLabel = label?.textContent;
  input.disabled = true;
  if (label) label.textContent = 'Uploading…';
  setInlineError('attachment-upload-error', '');
  try {
    const folder = sanitizeFolder(app.company_name);
    const meta = await uploadAttachment(folder, file);
    await createAttachment({
      entity_type: 'application',
      entity_id: app.id,
      folder: meta.folder,
      filename: meta.storedFilename,
      original_filename: meta.originalFilename,
      mime_type: meta.mimeType,
      size_bytes: meta.sizeBytes,
      sha256: meta.sha256,
    });
    toast(`Uploaded ${meta.storedFilename}`, 'ok');
    await renderDetails();
  } catch (err) {
    // Inline error under the Attachments heading — the toast lives out of
    // view when the details panel is scrolled below the fold.
    setInlineError('attachment-upload-error', `Upload failed: ${err.message}`);
    input.disabled = false;
    if (label && prevLabel) label.textContent = prevLabel;
    input.value = '';
  }
  // On success, renderDetails() replaces the input entirely — no need to
  // re-enable or clear it here.
};

const downloadAttachmentFromDetails = async (btn) => {
  const { folder, filename, original, mime } = btn.dataset;
  setInlineError('attachment-upload-error', '');
  try {
    const bytes = await downloadAttachment(folder, filename);
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = original || filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setInlineError('attachment-upload-error', `Download failed: ${err.message}`);
  }
};

const deleteAttachmentFromDetails = async (id) => {
  if (!confirm('Delete this attachment record? The file on disk/Drive is not removed.')) return;
  try {
    await deleteAttachment(id);
    toast('Attachment removed', 'ok');
    await renderDetails();
  } catch (err) {
    setInlineError('attachment-upload-error', `Delete failed: ${err.message}`);
  }
};

// ---------- entrypoint ----------
export const mountApplications = async (root) => {
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
    else toast(`Company #${rawCompanyID} not found — showing all applications`, 'warning');
  }

  await refreshList();

  // Auto-open the new-application editor if arriving via a quick-action link.
  if (params.get('new') === '1') openEditor('new');
};
