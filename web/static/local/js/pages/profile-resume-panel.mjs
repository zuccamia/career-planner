// Slide-over panel for editing a single résumé row. Owns the edit form,
// Typst compile + preview iframe, PDF download, and attach-to-application
// action. Same lifecycle as the company dossier panel: a hidden
// <section id="resume-panel"> lives on the page, we fill its innerHTML,
// then openSlideOver moves it into the fixed overlay.
//
// Layout (top → bottom): identity + title + primary toggle → attached-to
// applications history (same static-row pattern as companies/people
// dossiers) → source textarea → [re-render, save] → preview with filename
// + download button above the iframe → attach-to-application picker
// (hidden until a PDF is rendered). Download and Attach both stay disabled
// while the source in the textarea no longer matches the rendered PDF.

import { CLS } from '../ui/classes.mjs';
import { escapeHtml, formatDate, formatBytes } from '../ui/dom.mjs';
import { relativeAge } from '../ui/format.mjs';
import {
  badge, button, fileStamp, formField, helpText,
  inlineError, logPanel, panelTitle, sectionTitle, setInlineError, subheadTitle,
} from '../ui/components.mjs';
import { openSlideOver, closeSlideOver, isSlideOverOpen } from '../ui/slide_over.mjs';
import { toast } from '../ui/toast.mjs';
import { t } from '../i18n.mjs';
import {
  getResume, createResume, updateResume, deleteResume, setPrimaryResume,
  resumePdfFilename,
} from '../entities/resumes.mjs';
import { listPdfsForResume, linkPdfToApplication } from '../entities/resume-pdfs.mjs';
import { listApplications } from '../entities/applications.mjs';
import { listCompanies } from '../entities/companies.mjs';
import { getOverview } from '../entities/profile-overview.mjs';
import { uploadAttachment, sanitizeFolder } from '../storage/attachments.mjs';
import { compileTypstToPdf } from '../workers/typst-client.mjs';

const PANEL_ID = 'resume-panel';

// Module-local state — cleared on close. onClose callback lets the caller
// refresh the résumés list after Save / Delete / primary changes.
let currentResume = null;
let currentPdfBlob = null;
let currentPdfUrl = null;
let renderedBody = null;
let closingHandler = null;
// Applications list is fetched once per open() and cached to populate the
// inline attach picker. Kept alongside the company lookup so attach can
// resolve the target company name for the storage folder.
let attachApps = [];
let attachCompanyById = new Map();

const revokePdf = () => {
  if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
  currentPdfUrl = null;
  currentPdfBlob = null;
  renderedBody = null;
};

const resetState = () => {
  revokePdf();
  currentResume = null;
  closingHandler = null;
  attachApps = [];
  attachCompanyById = new Map();
};

// Orphan rows — PDFs whose paired application row was deleted — are dropped
// from the display. The bytes stay on disk (still referenced by the resume
// attachment row), just not listed here since the reference has no target.
const liveApplicationRows = (pdfList) =>
  pdfList.filter((r) => r.application_role_title);

const attachedRowsHtml = (pdfList) => liveApplicationRows(pdfList).map((r) => {
  const primary = r.application_company_name
    ? t('profile.resumes.sent.item_with_company', { role: r.application_role_title, company: r.application_company_name })
    : t('profile.resumes.sent.item', { role: r.application_role_title });
  const meta = `${formatDate(r.created_at)} · ${relativeAge(r.created_at)}${r.size_bytes ? ' · ' + formatBytes(r.size_bytes) : ''}`;
  return `
    <div class="${CLS.staticRow}">
      <div class="${CLS.flexTextCol}">
        <p class="${CLS.rowTitle}">${escapeHtml(primary)}</p>
        <p class="${CLS.fileRowMeta}">${escapeHtml(meta)}</p>
      </div>
    </div>`;
}).join('');

// Inline attach picker markup. Empty state when there are no applications
// yet — no point rendering a dropdown the user can't populate.
const attachPickerHtml = () => {
  if (!attachApps.length) return helpText(t('profile.resumes.attach.no_applications'));
  return `
    <div class="${CLS.gridFieldPair}">
      <label class="space-y-1">
        <span class="${CLS.label}">${escapeHtml(t('profile.resumes.attach.application_label'))}</span>
        <select id="resume-panel-attach-app" class="${CLS.select}">
          ${attachApps.map((a) => {
            const co = attachCompanyById.get(a.company_id);
            const label = `${a.role_title || '(no title)'} — ${co?.official_name || 'unknown'}`;
            return `<option value="${a.id}" data-company="${escapeHtml(co?.official_name || '')}">${escapeHtml(label)}</option>`;
          }).join('')}
        </select>
      </label>
      ${button({ id: 'btn-resume-attach', variant: 'secondaryCompact', icon: 'arrowUpTray', label: t('profile.resumes.action.attach') })}
    </div>
    ${inlineError({ id: 'resume-panel-attach-error' })}
  `;
};

// The "Applications" section is split across two locations: the header +
// history list live above the source (always visible), and the attach
// picker lives below the PDF preview and stays hidden until a PDF is
// rendered (nothing to attach otherwise).
const attachedListHtml = (pdfList) => {
  const live = liveApplicationRows(pdfList);
  return `
  <section id="resume-panel-attached-section" class="space-y-3">
    ${sectionTitle(t('profile.resumes.attached.title'))}
    <div id="resume-panel-attached">
      ${live.length ? `<div class="${CLS.divider}">${attachedRowsHtml(live)}</div>` : helpText(t('profile.resumes.sent.empty'))}
    </div>
  </section>`;
};

const attachPickerSectionHtml = () => `
  <section id="resume-panel-attach-picker-section" class="hidden space-y-2">
    <div id="resume-panel-attach-picker">${attachPickerHtml()}</div>
  </section>`;

const panelHtml = (resume, pdfList) => {
  const isNew = !resume.id;
  const eyebrow = isNew
    ? t('profile.resumes.form.new_eyebrow')
    : t('profile.resumes.form.edit_eyebrow');
  const isTypst = resume.format === 'typ';
  return `
    <div class="${CLS.slideOverBody}">
      <header class="${CLS.panelHeadRow}">
        <div class="${CLS.textCol}">
          ${isNew ? '' : fileStamp('resume', resume.id)}
          ${panelTitle(resume.title || t('profile.resumes.untitled'))}
          <p class="${CLS.eyebrow}">${escapeHtml(eyebrow)}</p>
        </div>
        <div class="${CLS.headActions}">
          ${isNew ? '' : button({ id: 'btn-resume-delete', variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('common.action.delete') })}
          ${button({ id: 'btn-resume-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.close') })}
        </div>
      </header>

      ${inlineError({ id: 'resume-panel-error' })}

      <section class="space-y-4">
        <div class="${CLS.chipRowInline}">
          ${badge({ label: isTypst ? t('profile.resumes.format.typst') : t('profile.resumes.format.markdown'), color: isTypst ? 'violet' : 'slate', size: 'xs' })}
          ${resume.is_primary ? badge({ label: t('profile.resumes.primary'), color: 'emerald', size: 'xs' }) : ''}
          ${isNew ? '' : `<span class="${CLS.metaText}">${escapeHtml(t('common.updated_at', { date: formatDate(resume.updated_at) }))}</span>`}
        </div>
        <form id="resume-panel-form" class="space-y-4">
          ${formField({ type: 'text', name: 'res-title', label: t('profile.resumes.field.title.label'),
                        value: resume.title || '', required: true,
                        placeholder: t('profile.resumes.field.title.placeholder') })}
          <label class="${CLS.inlineRow}">
            <input type="checkbox" id="res-primary" class="${CLS.checkbox}"${resume.is_primary ? ' checked' : ''}>
            <span class="${CLS.label}">${escapeHtml(t('profile.resumes.field.primary.label'))}</span>
          </label>
        </form>
      </section>

      ${attachedListHtml(pdfList)}

      <section class="space-y-2">
        ${subheadTitle(t('profile.resumes.field.source.label'))}
        <textarea id="res-body" spellcheck="false"
                  class="${CLS.textarea} ${CLS.codeText} min-h-[24rem] resize-y"
                  placeholder="${escapeHtml(t('profile.resumes.field.source.placeholder'))}">${escapeHtml(resume.body || '')}</textarea>
        <div class="${CLS.actionRowEnd}">
          ${button({ id: 'btn-resume-render', variant: 'secondaryCompact', icon: 'document', label: t('profile.resumes.action.render') })}
          ${button({ id: 'btn-resume-save', variant: 'primaryCompact', icon: 'check', label: t('common.action.save') })}
        </div>
        <span id="resume-panel-status" class="${CLS.helpText}"></span>
      </section>

      <section id="resume-panel-preview" class="${isTypst ? '' : 'hidden'} space-y-2">
        ${subheadTitle(t('profile.resumes.preview.title'))}
        ${inlineError({ id: 'resume-panel-compile-error' })}
        <div class="${CLS.actionRowBetween}">
          <span id="resume-panel-filename" class="${CLS.metaText}">${escapeHtml(resumePdfFilename({ name: '', fallback: resume.title || '' }))}</span>
          ${button({ id: 'btn-resume-download', variant: 'primaryCompact', icon: 'arrowDownTray', label: t('profile.resumes.action.download') })}
        </div>
        <iframe id="resume-panel-iframe" class="hidden h-[600px] w-full rounded-xl border border-line"
                title="${escapeHtml(t('profile.resumes.pdf_preview_title'))}"></iframe>
        <p id="resume-panel-preview-empty" class="${CLS.helpText}">${escapeHtml(t('profile.resumes.preview.empty'))}</p>
        ${logPanel({ id: 'resume-panel-compile-log' })}
      </section>

      ${attachPickerSectionHtml()}
    </div>
  `;
};

// Toggle Download + Attach based on whether the rendered PDF still matches
// the live textarea. Any keystroke drops back to disabled until re-render.
const syncActionButtons = () => {
  const dlBtn = document.getElementById('btn-resume-download');
  const attachBtn = document.getElementById('btn-resume-attach');
  const body = document.getElementById('res-body')?.value ?? '';
  const canDownload = !!currentPdfBlob && renderedBody === body;
  if (dlBtn) {
    dlBtn.disabled = !canDownload;
    dlBtn.title = canDownload ? '' : t('profile.resumes.download.needs_render');
  }
  if (attachBtn) {
    attachBtn.disabled = !canDownload || !currentResume?.id;
    attachBtn.title = attachBtn.disabled ? t('profile.resumes.download.needs_render') : '';
  }
  // Attach picker only surfaces once a PDF exists — nothing to attach
  // otherwise. The history list above the source stays visible either way.
  const picker = document.getElementById('resume-panel-attach-picker-section');
  if (picker) picker.classList.toggle('hidden', !currentPdfBlob);
};

const setStatus = (msg) => {
  const el = document.getElementById('resume-panel-status');
  if (el) el.textContent = msg || '';
};

// Format is not editable here — inherited from the row being opened, or
// defaults to `typ` for a brand-new résumé (the format the preview flow is
// built around).
const readForm = () => ({
  title: document.getElementById('res-title')?.value?.trim() || '',
  format: currentResume?.format || 'typ',
  body: document.getElementById('res-body')?.value || '',
  isPrimary: document.getElementById('res-primary')?.checked || false,
});

const compileAndShow = async () => {
  const iframe = document.getElementById('resume-panel-iframe');
  const emptyMsg = document.getElementById('resume-panel-preview-empty');
  const logEl = document.getElementById('resume-panel-compile-log');
  setInlineError('resume-panel-compile-error', '');
  const { body, format } = readForm();
  if (format !== 'typ') {
    setInlineError('resume-panel-compile-error', t('profile.resumes.compile.not_typst_source'));
    return;
  }
  if (!body.trim()) {
    setInlineError('resume-panel-compile-error', t('profile.resumes.compile.empty'));
    return;
  }
  setStatus(t('profile.resumes.compile.running'));
  logEl?.classList.add('hidden');
  try {
    const { pdf, log } = await compileTypstToPdf(body);
    revokePdf();
    currentPdfBlob = new Blob([pdf], { type: 'application/pdf' });
    currentPdfUrl = URL.createObjectURL(currentPdfBlob);
    renderedBody = body;
    if (iframe) {
      iframe.src = currentPdfUrl;
      iframe.classList.remove('hidden');
    }
    emptyMsg?.classList.add('hidden');
    setStatus(t('profile.resumes.compile.done', { size: formatBytes(currentPdfBlob.size) }));
    if (log && logEl) {
      logEl.textContent = log;
      logEl.classList.remove('hidden');
    }
  } catch (err) {
    setStatus('');
    const friendly = err.code === 'not_typst_source'
      ? t('profile.resumes.compile.not_typst_source')
      : (err.message || String(err));
    setInlineError('resume-panel-compile-error', t('profile.resumes.compile.failed', { err: friendly }));
    if (err.log && logEl) {
      logEl.textContent = err.log;
      logEl.classList.remove('hidden');
    }
  }
  syncActionButtons();
};

const saveResume = async () => {
  const { title, format, body, isPrimary } = readForm();
  setInlineError('resume-panel-error', '');
  if (!title) {
    setInlineError('resume-panel-error', t('profile.resumes.error.title_required'));
    return;
  }
  try {
    if (currentResume?.id) {
      await updateResume(currentResume.id, { title, format, body });
      if (isPrimary && !currentResume.is_primary) {
        await setPrimaryResume(currentResume.id);
      }
      toast(t('profile.resumes.toast.saved'), 'ok');
    } else {
      const id = await createResume({ title, format, body });
      currentResume = { id, title, format, body, is_primary: 0 };
      if (isPrimary) await setPrimaryResume(id);
      toast(t('profile.resumes.toast.created', { id }), 'ok');
    }
    currentResume = await getResume(currentResume.id);
    if (currentResume?.format === 'typ') {
      await compileAndShow();
    }
    if (closingHandler) closingHandler.saved = true;
  } catch (err) {
    setInlineError('resume-panel-error', t('profile.resumes.error.save_failed', { err: err?.message || String(err) }));
  }
};

const downloadPdf = async () => {
  if (!currentPdfBlob || !currentPdfUrl) return;
  const overview = await getOverview();
  const { title } = readForm();
  const a = document.createElement('a');
  a.href = currentPdfUrl;
  a.download = resumePdfFilename({ name: overview?.name, fallback: title });
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// Inline attach — reads the picker's selected application, uploads the
// current PDF to the paired company's storage folder, links both attachment
// rows (application + resume), then refreshes the list in-place.
const attachToApplication = async () => {
  const errId = 'resume-panel-attach-error';
  setInlineError(errId, '');
  if (!currentPdfBlob || !currentResume?.id) {
    setInlineError(errId, t('profile.resumes.attach.compile_first'));
    return;
  }
  const sel = document.getElementById('resume-panel-attach-app');
  if (!sel || !sel.value) return;
  const applicationId = Number(sel.value);
  const opt = sel.options[sel.selectedIndex];
  const overview = await getOverview();
  const originalFilename = resumePdfFilename({ name: overview?.name, fallback: readForm().title });
  const folder = sanitizeFolder(opt?.dataset?.company || 'unknown-company');
  const btn = document.getElementById('btn-resume-attach');
  if (btn) btn.disabled = true;
  try {
    const file = new File([currentPdfBlob], originalFilename, { type: 'application/pdf' });
    const meta = await uploadAttachment(folder, file);
    await linkPdfToApplication({
      resumeId: currentResume.id,
      applicationId,
      folder: meta.folder,
      storedFilename: meta.storedFilename,
      originalFilename: meta.originalFilename,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      sha256: meta.sha256,
    });
    toast(t('profile.resumes.toast.attached', { name: originalFilename }), 'ok');
    const pdfList = await listPdfsForResume(currentResume.id);
    const live = liveApplicationRows(pdfList);
    const box = document.getElementById('resume-panel-attached');
    if (box) {
      box.innerHTML = live.length
        ? `<div class="${CLS.divider}">${attachedRowsHtml(live)}</div>`
        : helpText(t('profile.resumes.sent.empty'));
    }
    if (closingHandler) closingHandler.attached = true;
  } catch (err) {
    const msg = err.code === 'no_storage_backend'
      ? t('common.error.no_storage_backend')
      : (err.message || String(err));
    setInlineError(errId, msg);
  } finally {
    if (btn) btn.disabled = false;
    syncActionButtons();
  }
};

const wire = () => {
  document.getElementById('btn-resume-close')?.addEventListener('click', () => closeSlideOver(PANEL_ID));
  document.getElementById('btn-resume-delete')?.addEventListener('click', async () => {
    if (!currentResume?.id) return;
    if (!confirm(t('profile.resumes.confirm.delete', { title: currentResume.title || t('profile.resumes.untitled') }))) return;
    try {
      await deleteResume(currentResume.id);
      toast(t('profile.resumes.toast.deleted'), 'ok');
      if (closingHandler) closingHandler.deleted = true;
      closeSlideOver(PANEL_ID);
    } catch (err) {
      setInlineError('resume-panel-error', err.message || String(err));
    }
  });
  document.getElementById('btn-resume-save')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    saveResume();
  });
  document.getElementById('btn-resume-render')?.addEventListener('click', () => compileAndShow());
  document.getElementById('btn-resume-download')?.addEventListener('click', () => downloadPdf());
  document.getElementById('btn-resume-attach')?.addEventListener('click', () => attachToApplication());
  document.getElementById('res-body')?.addEventListener('input', syncActionButtons);
  syncActionButtons();
};

// openResumePanel opens the slide-over for `resumeId`, or a create flow if
// null. `triggerEl` is the click origin (kept by openSlideOver for focus
// restore). `onClose` receives a report — { saved, deleted, attached } —
// so the caller can refresh selectively.
export const openResumePanel = async ({ resumeId = null, triggerEl = null, onClose } = {}) => {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  if (isSlideOverOpen(PANEL_ID)) closeSlideOver(PANEL_ID);
  const resume = resumeId
    ? await getResume(resumeId)
    : { id: null, title: '', format: 'typ', body: '', is_primary: 0 };
  if (!resume) {
    toast(t('profile.resumes.error.not_found', { id: resumeId }), 'error');
    return;
  }
  currentResume = resume;
  // Prefetch attach targets alongside the PDF list so the inline picker
  // renders synchronously with the panel HTML.
  const [pdfList, apps, companies] = await Promise.all([
    resume.id ? listPdfsForResume(resume.id) : Promise.resolve([]),
    resume.id ? listApplications() : Promise.resolve([]),
    resume.id ? listCompanies() : Promise.resolve([]),
  ]);
  attachApps = apps;
  attachCompanyById = new Map(companies.map((c) => [c.id, c]));
  panel.innerHTML = panelHtml(resume, pdfList);
  closingHandler = { saved: false, deleted: false, attached: false };
  openSlideOver({
    panelId: PANEL_ID,
    trigger: triggerEl,
    onClose: () => {
      const report = { ...closingHandler };
      resetState();
      if (onClose) onClose(report);
    },
  });
  wire();
};

export const closeResumePanel = () => closeSlideOver(PANEL_ID);
