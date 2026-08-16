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
  headlineStatus,
} from '../entities/applications.mjs';
import { relativeAge } from '../ui/format.mjs';
import { collectionListPanel, filterPillsHtml as collectionFilterPillsHtml, collectionRowsHtml } from '../ui/collection_list.mjs';
import {
  listAttachmentsByEntity, createAttachment, deleteAttachment,
} from '../entities/attachments.mjs';
import {
  sanitizeFolder, uploadAttachment, downloadAttachment,
} from '../storage/attachments.mjs';
import { listCompanies, getCompany } from '../entities/companies.mjs';
import { getPerson, listPeopleByCompanyID } from '../entities/people.mjs';
import { escapeHtml, formatDate, formatBytes } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { badge, badgeClasses, bulletList, button, codeBlock, collapsible, dtLabel, emptyState, faintSpan, fileRow, fileStamp, filterBanner, helpSpan, helpText, hintLink, inlineError, setInlineError, inlineNote, setInlineNote, inlineWarning, setInlineWarning, outputLanguageSelect, pageHeader, panelTitle, readOutputLanguage, sectionTitle, setPageCount, subsectionTitle, uploadButton } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { extractJobDescription } from '../rpc.mjs';
import { urlFor } from '../host.mjs';
import { createProgress } from '../ui/progress.mjs';
import { rememberPanelAnchor, mountInlinePanel, restoreAllPanels } from '../ui/panels.mjs';
import { openSlideOver, closeSlideOver, isSlideOverOpen } from '../ui/slide_over.mjs';
import { refreshSidebarCounts } from '../ui/sidebar_counts.mjs';
import { t } from '../i18n.mjs';

const PANEL_IDS = ['editor-panel', 'details-panel'];

// "online_assessment" -> "Online assessment"
const humanize = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '';

// Localized label for an application status slug. Falls back to humanize()
// for unknown values (e.g. legacy rows) so nothing renders blank.
const APPLICATION_STATUS_SLUGS = new Set([
  'lead', 'applied', 'online_assessment',
  'first_interview', 'second_interview', 'additional_interview',
  'offer', 'rejected', 'ghosted', 'withdrawn',
]);
const statusLabel = (s) =>
  s && APPLICATION_STATUS_SLUGS.has(s) ? t(`applications.status.${s}`) : humanize(s);

// Status → headline pill color. The four interview sub-stages collapse onto
// one brass pill — only the Sankey / stage strip in dashboard.mjs distinguishes
// their light→dark ramp. Withdrawn and Ghosted are distinct values that both
// render as hold gray.
const STATUS_BADGE_COLOR = {
  lead:                 'indigo',   // status-lead slate-blue
  applied:              'blue',     // brand teal
  online_assessment:    'amber',    // interview (brass)
  first_interview:      'amber',    // interview (brass)
  second_interview:     'amber',    // interview (brass)
  additional_interview: 'amber',    // interview (brass)
  offer:                'emerald',  // status-win green
  rejected:             'rose',     // status-out clay
  withdrawn:            'slate',    // status-hold gray (you exited)
  ghosted:              'slate',    // status-hold gray (they went silent)
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
    let base;
    if (from && to) base = t('applications.event.status_changed_from_to', { from: statusLabel(from), to: statusLabel(to) });
    else if (to) base = t('applications.event.status_changed_to', { to: statusLabel(to) });
    else base = t('applications.event.status_changed');
    if (content) return `${base} — ${content}`;
    return base;
  }
  if (type === 'created') {
    if (content) return content;
    if (to) return t('applications.event.created_with_status', { status: statusLabel(to) });
    return t('applications.event.created');
  }
  if (content) return content;
  if (to) return from ? `${statusLabel(from)} → ${statusLabel(to)}` : statusLabel(to);
  return humanize(type);
};

// ---------- markup: shell + editor + list ----------

const shellHtml = () => `
  <div class="space-y-6">
    <div id="toast" class="hidden"></div>

    <section class="${CLS.pageHeadRow}">
      ${pageHeader({ page: 'applications', title: t('page.applications.title'), countId: 'app-count' })}
      ${button({ id: 'btn-new', variant: 'primaryCompact', icon: 'plus', label: t('applications.action.new'), ariaLabel: t('applications.aria.add') })}
    </section>

    <section id="editor-panel" class="hidden"></section>
    <section id="details-panel" class="hidden"></section>

    ${collectionListPanel({
      searchId: 'apps-search',
      searchPlaceholder: t('applications.search.placeholder'),
      filtersId: 'apps-filters',
      filtersAriaLabel: t('applications.filters.aria'),
    })}
  </div>
`;

const noCompaniesHtml = () => `
  <div class="${CLS.card}">
    <div class="${CLS.formHeadRow}">
      <p class="${CLS.eyebrow}">${t('applications.no_company.heading')}</p>
      ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.cancel') })}
    </div>
    <p class="${CLS.bodyText}">
      ${t('applications.no_company.body')}
    </p>
    ${button({ kind: 'link', href: urlFor('companies?new=1'), icon: 'plus', label: t('applications.no_company.cta') })}
  </div>
`;

// personOptions renders the <option>s inside the person dropdown. Broken out
// so we can rebuild it in place when the selected company changes without
// re-rendering the whole editor.
const personOptions = (people, selectedID) => [
  `<option value="">${t('applications.field.contact.none')}</option>`,
  ...people.map(p => `
    <option value="${p.id}" ${String(p.id) === String(selectedID ?? '') ? 'selected' : ''}>
      ${escapeHtml(p.full_name)}${p.title ? ` — ${escapeHtml(p.title)}` : ''}
    </option>`),
].join('');

const editorHtml = (app, companies, people) => {
  const isNew = !app;
  const a = app || {};
  const status = a.status || 'lead';
  const selectedCompany = isNew ? '' : String(a.company_id ?? '');
  const companyOptions = [
    `<option value="" disabled ${selectedCompany ? '' : 'selected'}>${t('applications.field.company.placeholder')}</option>`,
    ...companies.map(c => `
      <option value="${c.id}" ${String(c.id) === selectedCompany ? 'selected' : ''}>
        ${escapeHtml(c.official_name)}
      </option>`),
  ].join('');
  return `
    <div class="${CLS.card}">
      <form id="editor-form" class="space-y-5">
        <div class="${CLS.formHeadRow}">
          <p class="${CLS.eyebrow}">${isNew ? t('applications.form.new_eyebrow') : t('applications.form.edit_eyebrow')}</p>
          <div class="${CLS.rowInline}">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: isNew ? t('applications.form.aria.create') : t('common.action.save_changes') })}
            ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.cancel') })}
          </div>
        </div>

        ${inlineError({ id: 'editor-error' })}

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:items-start">
          <div class="grid gap-2">
            <label class="${CLS.label}" for="company_id">${t('applications.field.company.label')}</label>
            <select id="company_id" name="company_id" required class="${CLS.select}">
              ${companyOptions}
            </select>
            ${hintLink({
              prefix: t('applications.field.company.help_prefix'),
              href: urlFor('companies?new=1'),
              linkLabel: t('applications.field.company.help_link'),
            })}
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="role_title">${t('applications.field.role.label')}</label>
            <input id="role_title" name="role_title" type="text" required
                   value="${escapeHtml(a.role_title)}" placeholder="${t('applications.field.role.placeholder')}"
                   class="${CLS.input}">
          </div>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="person_id">${t('applications.field.contact.label')}</label>
          <select id="person_id" name="person_id" class="${CLS.select}">
            ${personOptions(people, a.person_id)}
          </select>
          ${helpText(t('applications.field.contact.help'))}
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="job_posting_url">${t('applications.field.url.label')}</label>
          <input id="job_posting_url" name="job_posting_url" type="url"
                 value="${escapeHtml(a.job_posting_url)}" placeholder="${t('common.placeholder.url')}"
                 class="${CLS.input}">
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="status">${t('applications.field.status.label')}</label>
          <select id="status" name="status" class="${CLS.select}">
            ${APPLICATION_STATUSES.map(s => `
              <option value="${s}" ${s === status ? 'selected' : ''}>${statusLabel(s)}</option>
            `).join('')}
          </select>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="job_description_raw">${t('applications.field.jd.label')}</label>
          <textarea id="job_description_raw" name="job_description_raw" rows="8"
                    class="${CLS.textarea} font-mono"
                    placeholder="${t('applications.field.jd.placeholder')}">${escapeHtml(a.job_description_raw)}</textarea>
        </div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="notes">${t('applications.field.notes.label')}</label>
          <textarea id="notes" name="notes" rows="3" class="${CLS.textarea}">${escapeHtml(a.notes)}</textarea>
        </div>
      </form>
    </div>
  `;
};

const HEADLINE_BADGE = {
  lead:      'indigo',
  applied:   'blue',
  interview: 'amber',
  offer:     'emerald',
  rejected:  'rose',
  ghosted:   'slate',
  withdrawn: 'slate',
};

const headlinePill = (h) => h
  ? badge({ color: HEADLINE_BADGE[h] || 'slate', size: 'xs', label: t(`applications.status.headline.${h}`) })
  : '';

const rowMeta = (a) => {
  const parts = [];
  parts.push(a.company_name || t('applications.details.unknown_company'));
  const ageKey = a.status === 'lead'
    ? 'companies.dossier.applications.added'
    : 'companies.dossier.applications.applied';
  if (a.created_at) parts.push(t(ageKey, { age: relativeAge(a.created_at) }));
  return parts.join('  ·  ');
};

const appFileRow = (a) => {
  return fileRow({
    id: a.id,
    jsClass: 'js-details',
    ariaLabel: t('applications.aria.open', { label: a.role_title }),
    title: a.role_title,
    pill: headlinePill(headlineStatus(a.status)),
    meta: rowMeta(a),
  });
};

const clearAllHtml = () => `
  <div class="mt-6 flex justify-end ${CLS.dividerTop}">
    ${button({ id: 'btn-clear-all', variant: 'dangerCompact', icon: 'trash', label: t('applications.action.clear_all') })}
  </div>`;

// ---------- markup: details panel ----------

const chips = (items, color) => (items || [])
  .map(item => `<span class="${badgeClasses(color, 'sm')} mb-2 mr-2">${escapeHtml(item)}</span>`)
  .join('');


const structuredHtml = (parsed) => {
  if (!parsed.ok) {
    return inlineWarning({ message: t('applications.details.jd_error') });
  }
  const s = parsed.data;
  if (!s) {
    return emptyState({ message: t('applications.details.jd_empty') });
  }
  const req = s.requirements || {};
  const salaryLabel = formatSalary(s.salary?.currency, s.salary?.amount);
  const hasDeadline = !!(s.application_deadline || '').trim();
  const hasSalary = !!salaryLabel;
  const anyBadge = s.role_level || s.employment_type || s.season || (s.year > 0) || hasDeadline || hasSalary;
  return `
    <div class="space-y-6">
      <section class="space-y-4">
        <div class="${CLS.chipRow}">
          ${s.role_level ? badge({ label: humanize(s.role_level), color: 'violet' }) : ''}
          ${s.employment_type ? badge({ label: humanize(s.employment_type), color: 'blue' }) : ''}
          ${s.season
            ? badge({ label: `${humanize(s.season)}${s.year > 0 ? ' ' + s.year : ''}`, color: 'emerald' })
            : (s.year > 0 ? badge({ label: String(s.year), color: 'emerald' }) : '')}
          ${hasDeadline ? badge({ label: s.application_deadline, color: 'rose' }) : ''}
          ${hasSalary ? badge({ label: salaryLabel, color: 'amber' }) : ''}
          ${!anyBadge ? `${helpSpan(t('applications.details.meta_empty'))}` : ''}
        </div>
        <div class="grid gap-1">
          ${dtLabel(t('applications.details.summary_label'))}
          <dd>${(s.summary || '').trim() ? escapeHtml(s.summary) : `${helpSpan(t('applications.details.summary_empty'))}`}</dd>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-3">
          ${subsectionTitle(t('applications.details.minimum_qualifications'))}
          ${(s.minimum_qualifications || []).length ? bulletList(s.minimum_qualifications) : emptyState({ message: t('applications.details.minimum_qualifications_empty') })}
        </div>
        <div class="space-y-3">
          ${subsectionTitle(t('applications.details.preferred_qualifications'))}
          ${(s.preferred_qualifications || []).length ? bulletList(s.preferred_qualifications) : emptyState({ message: t('applications.details.preferred_qualifications_empty') })}
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-3">
          ${subsectionTitle(t('applications.details.responsibilities'))}
          ${(s.responsibilities || []).length ? bulletList(s.responsibilities) : emptyState({ message: t('applications.details.responsibilities_empty') })}
        </div>
        <div class="space-y-3">
          ${subsectionTitle(t('applications.details.requirements'))}
          <dl class="space-y-3">
            <div class="${CLS.chipRow}">
              ${req.transcript_required ? badge({ label: t('applications.details.transcript_required'), color: 'rose' }) : ''}
              ${chips(req.education, 'slate')}
              ${chips(req.majors, 'indigo')}
            </div>
            <div class="grid gap-1">
              ${dtLabel(t('applications.details.work_auth'))}
              <dd class="${CLS.bodyText}">${(req.work_authorization || '').trim() ? escapeHtml(req.work_authorization) : `${helpSpan(t('common.status.not_identified'))}`}</dd>
            </div>
            <div class="grid gap-1">
              ${dtLabel(t('applications.details.availability'))}
              <dd class="${CLS.bodyText}">${(req.availability || []).length
                ? `<div class="space-y-1">${req.availability.map(v => `<p>${escapeHtml(v)}</p>`).join('')}</div>`
                : `${helpSpan(t('common.status.not_identified'))}`}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-3">
        <div class="space-y-3">
          ${subsectionTitle(t('applications.details.languages'))}
          <div>${(s.languages || []).length ? chips(s.languages, 'emerald') : `${helpSpan(t('common.status.not_identified'))}`}</div>
        </div>
        <div class="space-y-3">
          ${subsectionTitle(t('applications.details.skills'))}
          <div>${(s.skills || []).length ? chips(s.skills, 'emerald') : `${helpSpan(t('common.status.not_identified'))}`}</div>
        </div>
        <div class="space-y-3">
          ${subsectionTitle(t('applications.details.domains'))}
          <div>${(s.domains || []).length ? chips(s.domains, 'emerald') : `${helpSpan(t('common.status.not_identified'))}`}</div>
        </div>
      </section>

      <section class="space-y-3">
        ${subsectionTitle(t('applications.details.logistics'))}
        <dl class="${CLS.gridTwoCol} gap-4">
          <div class="grid gap-1 sm:col-span-2">
            ${dtLabel(t('applications.details.locations'))}
            <dd>${(s.locations || []).length ? chips(s.locations, 'blue') : `${helpSpan(t('common.status.not_identified'))}`}</dd>
          </div>
          <div class="grid gap-1 sm:col-span-2">
            ${dtLabel(t('applications.details.location_notes'))}
            <dd>${(s.location_notes || '').trim() ? escapeHtml(s.location_notes) : helpSpan(t('applications.details.location_notes_empty'))}</dd>
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
    extraClass: 'js-download-attachment !text-ink hover:!text-brand hover:underline font-semibold',
    ariaLabel: t('applications.aria.download_attachment', { name: att.original_filename }),
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
    ariaLabel: t('applications.aria.delete_attachment', { name: att.original_filename }),
    extraClass: 'js-delete-attachment',
    dataset: { id: att.id },
  });
  return `
    <li class="${CLS.softRow}">
      <div class="${CLS.actionRowBetween}">
        <div class="min-w-0 flex-1">
          ${nameBtn}
          <p class="mt-1 ${CLS.helpText}">
            <span class="break-all">${escapeHtml(att.folder)}/${escapeHtml(att.filename)}</span>
            <span class="mx-1">·</span>
            <span>${escapeHtml(formatBytes(att.size_bytes))}</span>
            ${att.mime_type ? `<span class="mx-1">·</span><span>${escapeHtml(att.mime_type)}</span>` : ''}
          </p>
        </div>
        <div class="${CLS.headActions}">${deleteBtn}</div>
      </div>
    </li>
  `;
};

const attachmentsSectionHtml = (a, attachments) => {
  const folderPreview = sanitizeFolder(a.company_name);
  return `
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        ${sectionTitle(t('applications.details.attachments'))}
      </div>
      ${inlineError({ id: 'attachment-upload-error' })}
      ${uploadButton({
        id: 'attachment-upload-input',
        labelId: 'attachment-upload-label',
        label: t('applications.action.upload_file'),
        help: t('applications.details.attachments_help', { folder: escapeHtml(folderPreview) }),
      })}
      ${attachments.length
        ? `<ul class="space-y-3">${attachments.map(attachmentCardHtml).join('')}</ul>`
        : emptyState({ message: t('applications.details.attachments_empty') })}
    </div>
  `;
};

// Timeline renders the latest event always, and hides the rest behind a
// native <details> "more…" toggle. Events arrive sorted DESC by occurred_at
// (see listEventsByApplication) so events[0] is the latest.
const timelineEventHtml = (ev) => `
  <li class="${CLS.softRow} ${CLS.bodyText}">
    ${faintSpan(formatDate(ev.occurred_at))}
    <span aria-hidden="true"> — </span>
    <span>${escapeHtml(eventSummary(ev))}</span>
  </li>
`;

const timelineHtml = (events) => {
  const [latest, ...rest] = events;
  return `
    <ul class="space-y-3">${timelineEventHtml(latest)}</ul>
    ${rest.length ? collapsible({
      summary: t('applications.details.more_events'),
      openSummary: t('common.action.less'),
      content: `<ul class="mt-3 space-y-3">${rest.map(timelineEventHtml).join('')}</ul>`,
    }) : ''}
  `;
};

const detailsHtml = (a, events, attachments, { editing = false, companies = [], people = [] } = {}) => {
  const status = a.status || 'lead';
  const pillClass = badgeClasses(STATUS_BADGE_COLOR[status] || 'slate');
  const url = escapeHtml(a.job_posting_url || '');
  const hasRaw = !!(a.job_description_raw || '').trim();
  const hasURL = !!(a.job_posting_url || '').trim();
  const parsed = parseStructured(a.job_description_extracted_json);
  const hasNotes = !!(a.notes || '').trim();
  const hasPerson = !!a.person_id;
  return `
    <div class="${CLS.slideOverBody}">
      <header class="space-y-2">
        <div class="flex items-center justify-between gap-3">
          ${fileStamp('application', a.id)}
          <div class="${CLS.rowInline}">
            ${button({ id: 'btn-details-edit', variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: t('applications.aria.edit') })}
            ${button({ id: 'btn-details-delete', variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('applications.aria.delete', { label: a.role_title }) })}
            ${button({ id: 'btn-details-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.close') })}
          </div>
        </div>
        <div class="${CLS.textCol}">
          <p class="${CLS.eyebrow}">${escapeHtml(a.company_name) || t('applications.details.unknown_company')}</p>
          ${panelTitle(a.role_title, `${hasURL
              ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="hover:text-brand hover:underline">${escapeHtml(a.role_title)}</a>`
              : escapeHtml(a.role_title)} <span class="${pillClass} align-middle ml-1">${escapeHtml(statusLabel(status))}</span>`)}
        </div>
      </header>

      ${inlineError({ id: 'details-error' })}
      ${inlineNote({ id: 'details-note' })}
      ${inlineWarning({ id: 'details-warning' })}
      <div id="details-progress" class="hidden"></div>

      ${editing ? editorHtml(a, companies, people) : `
      ${hasRaw || hasURL ? `
      <div class="flex flex-wrap items-center justify-end gap-2">
        ${outputLanguageSelect('out-lang-extract-jd')}
        ${button({ id: 'btn-details-extract', icon: 'sparkles', label: t('applications.action.extract_description') })}
      </div>` : ''}
      <form id="quick-status-form" class="${CLS.paperCard} grid gap-3 pt-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end">
        <div class="grid gap-2">
          <label class="${CLS.label}" for="quick-status">${t('applications.quickstatus.status.label')}</label>
          <select class="${CLS.select}" id="quick-status" name="status">
            ${APPLICATION_STATUSES.map(s => `
              <option value="${s}" ${s === status ? 'selected' : ''}>${statusLabel(s)}</option>
            `).join('')}
          </select>
        </div>
        <div class="grid gap-2">
          <label class="${CLS.label}" for="quick-occurred-at">${t('applications.quickstatus.date.label')}</label>
          <input class="${CLS.input}" id="quick-occurred-at" name="occurred_at" type="date">
        </div>
        <div class="grid gap-2">
          <label class="${CLS.label}" for="quick-notes">${t('applications.quickstatus.short_notes.label')}</label>
          <input class="${CLS.input}" id="quick-notes" name="notes" type="text" maxlength="255" placeholder="${t('applications.quickstatus.short_notes.placeholder')}">
        </div>
        <div class="flex justify-end sm:block">
          ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('applications.action.update_status') })}
        </div>
      </form>

      ${(hasPerson || hasNotes) ? `
        <dl class="${CLS.paperCard} ${CLS.gridTwoCol} gap-4">
          ${hasPerson ? `
            <div class="grid gap-1">
              ${dtLabel(t('applications.details.point_of_contact'))}
              <dd>${a.person_name ? escapeHtml(a.person_name) : t('applications.details.person_fallback', { id: a.person_id })}</dd>
            </div>` : ''}
          <div class="grid gap-1 sm:col-span-2">
            ${dtLabel(t('applications.details.notes'))}
            <dd>${hasNotes ? escapeHtml(a.notes) : `${helpSpan(t('applications.details.notes_empty'))}`}</dd>
          </div>
        </dl>` : ''}

      <div class="space-y-3">
        ${sectionTitle(t('applications.details.jd_section'))}
        ${structuredHtml(parsed)}
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="space-y-3">
          ${sectionTitle(t('applications.details.timeline'))}
          ${events.length ? timelineHtml(events) : emptyState({ message: t('applications.details.timeline_empty') })}
        </div>
        ${attachmentsSectionHtml(a, attachments)}
      </div>

      ${collapsible({
        title: t('applications.details.raw_jd'),
        summary: t('common.action.show'),
        openSummary: t('common.action.hide'),
        extraClass: CLS.paperCard,
        content: `<div class="mt-4">${hasRaw
          ? codeBlock(a.job_description_raw)
          : emptyState({ message: t('applications.details.raw_jd_empty') })}</div>`,
      })}
      `}
    </div>
  `;
};

// ---------- state + handlers ----------
let editorMode = null;    // null | 'new' | { id }
let editorSubject = null; // cached row loaded into the editor — used to
                          // preserve fields the form doesn't expose (extracted
                          // JD JSON, person_id) so saves don't wipe them.
let detailsID = null;     // null | number — id of the application shown in details panel
let applicationEditing = false;
// Optional company_id filter (from ?company_id=… — set by company-card pill).
let companyFilter = null; // { id, name } | null
// Optional person_id filter (from ?person_id=… — silent, no banner/pill;
// used by the "View" link on a person's slide-over).
let personFilter = null;  // { id, name } | null
let filterState = { headline: 'all', query: '' };
let cachedApps = [];

const HEADLINE_FILTERS = ['all', 'lead', 'applied', 'interview', 'offer', 'rejected', 'ghosted'];
const filterOptions = () => HEADLINE_FILTERS.map(k => ({ key: k, label: t(`applications.filters.${k}`) }));

const filterBannerHtml = () => companyFilter
  ? filterBanner({
      label: t('common.filter.by_company'),
      name: companyFilter.name,
      clearHref: urlFor('applications'),
      clearLabel: t('common.filter.clear'),
    })
  : '';

// isUnfiltered reports whether the list is showing the full application
// set — no URL scoping, no search query, no headline pill selection. The
// "Clear all applications" button only appears in this state so a user
// filtered down to a subset can't accidentally wipe everything.
const isUnfiltered = () =>
  !companyFilter && !personFilter && !filterState.query.trim() && filterState.headline === 'all';

const applyFilters = () => {
  const q = filterState.query.trim().toLowerCase();
  return cachedApps.filter(a => {
    if (companyFilter && a.company_id !== companyFilter.id) return false;
    if (personFilter && a.person_id !== personFilter.id) return false;
    if (q) {
      const hay = `${a.role_title || ''} ${a.company_name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filterState.headline === 'all') return true;
    return headlineStatus(a.status) === filterState.headline;
  });
};

const renderList = () => {
  const filtered = applyFilters();
  restoreAllPanels(PANEL_IDS);
  document.getElementById('list-content').innerHTML =
    filterBannerHtml()
    + collectionRowsHtml({ rows: filtered.map(appFileRow), emptyMessage: t('applications.list.empty') })
    + (filtered.length && isUnfiltered() ? clearAllHtml() : '');
  if (editorMode && editorMode !== 'new') mountInlinePanel('editor-panel', editorMode.id);
  setPageCount('app-count', filtered.length, n => companyFilter
    ? t(n === 1 ? 'applications.list.count_one_at_company' : 'applications.list.count_many_at_company', { n, company: companyFilter.name })
    : t(n === 1 ? 'applications.list.count_one_all' : 'applications.list.count_many_all', { n }));
  document.getElementById('apps-filters').innerHTML = collectionFilterPillsHtml(filterOptions(), filterState.headline);
  wireListHandlers();
};

const wireListHandlers = () => {
  document.querySelectorAll('.js-details').forEach(btn =>
    btn.addEventListener('click', () => openDetails(Number(btn.dataset.id), btn)));
  document.querySelectorAll('.js-filter').forEach(btn =>
    btn.addEventListener('click', () => {
      filterState.headline = btn.dataset.filter;
      renderList();
    }));
  document.getElementById('btn-clear-all')?.addEventListener('click', clearAllApplicationsFromList);
};

const refreshList = async () => {
  cachedApps = await listApplications();
  renderList();
  refreshSidebarCounts().catch(() => {});
};

// Clear every application (and its events + attachment records) in one shot.
// Meant for starting a new time-period snapshot with the same longer-lived
// companies/people data intact.
const clearAllApplicationsFromList = async () => {
  if (!confirm(t('applications.confirm.clear_all'))) return;
  setInlineError('list-error', '');
  try {
    if (editorMode) closeEditor();
    if (detailsID) closeDetails();
    const { deleted } = await clearAllApplications();
    toast(t(deleted === 1 ? 'applications.toast.cleared_one' : 'applications.toast.cleared_many', { n: deleted }), 'ok');
    await refreshList();
  } catch (err) {
    setInlineError('list-error', t('applications.error.clear_failed', { err: err.message }));
  }
};

const deleteApplicationFromList = async (id, label, errorID = 'list-error') => {
  if (!confirm(t('applications.confirm.delete', { label }))) return;
  setInlineError(errorID, '');
  try {
    await deleteApplication(id);
    if (editorMode && editorMode !== 'new' && editorMode.id === id) closeEditor();
    if (detailsID === id) closeDetails();
    toast(t('applications.toast.deleted'), 'ok');
    await refreshList();
  } catch (err) {
    setInlineError(errorID, t('common.error.delete_failed', { err: err.message }));
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
      toast(t('applications.error.not_found', { id: mode.id }), 'error');
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
    status: (fd.get('status') || 'lead').toString(),
    job_description_raw: (fd.get('job_description_raw') || '').toString(),
    notes: (fd.get('notes') || '').toString(),
  };
};

const wireEditor = ({ onCancel, onSaved } = {}) => {
  const cancelFn = onCancel || closeEditor;
  const savedFn = onSaved || (async () => { closeEditor(); await refreshList(); });
  const form = document.getElementById('editor-form');
  document.getElementById('btn-cancel').addEventListener('click', cancelFn);

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
      setInlineError('editor-error', t('applications.error.company_and_role_required'));
      return;
    }
    try {
      if (editorMode === 'new') {
        const id = await createApplication(data);
        toast(t('applications.toast.created', { id }), 'ok');
      } else {
        // person_id + company_id + notes come from the form; job_description_extracted_json
        // isn't exposed here so preserve whatever the row already has.
        await updateApplication(editorMode.id, {
          ...data,
          job_description_extracted_json: editorSubject?.job_description_extracted_json ?? '{}',
        });
        toast(t('applications.toast.saved'), 'ok');
      }
      await savedFn();
    } catch (err) {
      setInlineError('editor-error', t('common.error.save_failed', { err: err.message }));
    }
  });
};

// ---------- details panel ----------

const closeDetails = () => {
  if (isSlideOverOpen('details-panel')) {
    closeSlideOver('details-panel');
    return;
  }
  detailsID = null;
  const panel = document.getElementById('details-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
};

const renderDetails = async () => {
  if (!detailsID) return;
  const app = await getApplication(detailsID);
  if (!app) {
    toast(t('applications.error.not_found', { id: detailsID }), 'error');
    closeDetails();
    return;
  }
  const [events, attachments] = await Promise.all([
    listEventsByApplication(detailsID),
    listAttachmentsByEntity('application', detailsID),
  ]);
  let companies = [];
  let people = [];
  if (applicationEditing) {
    [companies, people] = await Promise.all([
      listCompanies(),
      app.company_id ? listPeopleByCompanyID(app.company_id) : Promise.resolve([]),
    ]);
    editorMode = { id: app.id };
    editorSubject = app;
  }
  const panel = document.getElementById('details-panel');
  panel.innerHTML = detailsHtml(app, events, attachments, { editing: applicationEditing, companies, people });
  wireDetails(app);
  if (applicationEditing) {
    wireEditor({
      onCancel: () => {
        applicationEditing = false;
        editorMode = null;
        editorSubject = null;
        renderDetails();
      },
      onSaved: async () => {
        applicationEditing = false;
        editorMode = null;
        editorSubject = null;
        await refreshList();
        await renderDetails();
      },
    });
  }
};

const openDetails = async (id, triggerEl = null) => {
  closeEditor();
  detailsID = id;
  await renderDetails();
  openSlideOver({
    panelId: 'details-panel',
    trigger: triggerEl,
    onClose: () => {
      detailsID = null;
      applicationEditing = false;
      editorMode = null;
      editorSubject = null;
    },
  });
};

const wireDetails = (app) => {
  document.getElementById('btn-details-close').addEventListener('click', closeDetails);
  document.getElementById('btn-details-edit')?.addEventListener('click', () => {
    if (!detailsID) return;
    applicationEditing = true;
    renderDetails();
  });
  document.getElementById('btn-details-delete')?.addEventListener('click', () => {
    if (!detailsID) return;
    deleteApplicationFromList(detailsID, app.role_title || `#${detailsID}`, 'details-error');
  });

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
      toast(before === status ? t('applications.toast.status_unchanged') : t('applications.toast.status_changed', { status: statusLabel(status) }), before === status ? 'warning' : 'ok');
      await renderDetails();
      await refreshList();
    } catch (err) {
      setInlineError('details-error', t('applications.error.status_update_failed', { err: err.message }));
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
    setInlineWarning('details-warning', '');
    const progress = createProgress(document.getElementById('details-progress'));
    progress.reset();
    try {
      const resp = await extractJobDescription({
        company_name: app.company_name || '',
        role_title: app.role_title || '',
        job_posting_url: app.job_posting_url || '',
        job_description_raw: app.job_description_raw || '',
      }, readOutputLanguage('out-lang-extract-jd'), progress.asCallback());
      await updateApplicationExtraction(app.id, {
        structuredJson: JSON.stringify(resp.structured || {}),
        jobDescriptionRaw: resp.job_description_raw || '',
      });
      const reason = (resp.structured?.reasoning || '').trim();
      const warning = (resp.warning || '').trim();
      await renderDetails();
      // renderDetails re-renders the panel; re-apply the note after paint.
      setInlineNote('details-note', reason ? t('applications.toast.jd_extracted_with_reason', { reason }) : t('applications.toast.jd_extracted'));
      setInlineWarning('details-warning', warning);
    } catch (err) {
      setInlineError('details-error', t('applications.error.extract_failed', { err: err.message }));
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
    toast(t('applications.toast.uploaded', { name: meta.storedFilename }), 'ok');
    await renderDetails();
  } catch (err) {
    // Inline error under the Attachments heading — the toast lives out of
    // view when the details panel is scrolled below the fold.
    const detail = err.code === 'no_storage_backend' ? t('common.error.no_storage_backend') : err.message;
    setInlineError('attachment-upload-error', t('applications.error.upload_failed', { err: detail }));
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
    setInlineError('attachment-upload-error', t('common.error.download_failed', { err: err.message }));
  }
};

const deleteAttachmentFromDetails = async (id) => {
  if (!confirm(t('applications.confirm.delete_attachment'))) return;
  try {
    await deleteAttachment(id);
    toast(t('applications.toast.attachment_removed'), 'ok');
    await renderDetails();
  } catch (err) {
    setInlineError('attachment-upload-error', t('common.error.delete_failed', { err: err.message }));
  }
};

// ---------- entrypoint ----------
export const mountApplications = async (root) => {
  root.innerHTML = shellHtml();
  PANEL_IDS.forEach(rememberPanelAnchor);
  document.getElementById('btn-new').addEventListener('click', () => openEditor('new'));
  document.getElementById('apps-search').addEventListener('input', (e) => {
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
    else toast(t('applications.toast.company_missing_filter', { id: rawCompanyID }), 'warning');
  }
  const rawPersonID = Number(params.get('person_id'));
  if (rawPersonID) {
    const person = await getPerson(rawPersonID);
    if (person) personFilter = { id: person.id, name: person.full_name };
  }

  await refreshList();

  // Auto-open the new-application editor if arriving via a quick-action link.
  if (params.get('new') === '1') openEditor('new');
};
