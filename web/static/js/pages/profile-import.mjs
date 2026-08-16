// Résumé / brag sheet import: an in-page flow rendered inside the Profile
// page. Runs entirely in the browser — preflight → magic-byte sniff →
// wasm extraction (workers/extract-client) → Markdown display → three
// downstream flows (brags, overview, Typst). This module is the shell:
// upload UI, MD result editor, and the row of extraction buttons. The
// per-flow logic lives in profile-import-{brags,overview,typst}.mjs, each
// exporting a `wire*` function this orchestrator calls after render.
//
// Context shape (all required):
//   mountEl   — element whose innerHTML is replaced with the import UI
//   onExit()  — called when the user clicks Back; the caller re-renders
//               whatever view launched the flow

import { escapeHtml } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { badgeClasses, button, helpText, inlineError, inlineWarning, panelTitle, setInlineError, setInlineWarning, subheadTitle, uploadButton } from '../ui/components.mjs';
import { t } from '../i18n.mjs';
import { extractResume } from '../workers/extract-client.mjs';
import { wireBragsExtract } from './profile-import-brags.mjs';
import { wireOverviewExtract } from './profile-import-overview.mjs';
import { wireTypstBuild } from './profile-import-typst.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const hasMagic = (bytes, magic) => magic.every((b, i) => bytes[i] === b);
const sniff = (bytes) => {
  if (hasMagic(bytes, PDF_MAGIC)) return 'pdf';
  if (hasMagic(bytes, ZIP_MAGIC)) return 'docx';
  return 'unknown';
};

// deviceMemory is coarse (rounded, capped at 8). Used only to nudge phone
// users toward a laptop before they wait for a large wasm parse to fail.
const preflightBanner = () => {
  const mem = navigator.deviceMemory;
  if (typeof mem !== 'number' || mem >= 2) return '';
  return `
    <div class="${CLS.warningBanner}">
      ${escapeHtml(t('profile_import.preflight.low_memory'))}
    </div>`;
};

const uploadHtml = () => `
  <div class="flex flex-col items-center gap-2 py-4 text-center">
    ${uploadButton({
      id: 'ri-file',
      label: t('profile_import.button.choose'),
      accept: '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      help: t('profile_import.dropzone.hint'),
    })}
  </div>`;

// Spinner + label row. `hidden` (display:none) wins over `flex` until removed
// via classList. Callers pass labelId (dynamic text via setStatus) or
// staticLabel (baked in at render time).
const spinnerRow = ({ id, labelId = '', staticLabel = '' }) => `
  <div id="${id}" class="hidden ${CLS.responsiveRow} ${CLS.bodyText}">
    <span data-icon="loader" data-icon-size="4" class="animate-spin"></span>
    ${labelId
      ? `<span id="${labelId}"></span>`
      : `<span>${escapeHtml(staticLabel)}</span>`}
  </div>`;

const statusHtml = () => `
  ${spinnerRow({ id: 'ri-status', labelId: 'ri-status-label' })}
  ${inlineError({ id: 'ri-error' })}`;

const resultHtml = () => `
  <div id="ri-result" class="hidden space-y-3">
    <div class="flex items-center justify-between">
      ${subheadTitle(t('profile_import.result.title'))}
      <span id="ri-result-kind" class="${badgeClasses('slate', 'xs')} font-mono uppercase"></span>
    </div>
    ${helpText(t('profile_import.result.hint'))}
    ${inlineWarning({ id: 'ri-warnings' })}
    <textarea id="ri-markdown" spellcheck="false"
              class="${CLS.textarea} ${CLS.codeText} min-h-[40vh] max-h-[70vh] resize-y"></textarea>
    ${helpText(t('profile_import.result.chunk_hint'))}
    <div class="${CLS.formRow}">
      ${button({ id: 'ri-overview-extract', variant: 'primary', icon: 'sparkles', label: t('profile_import.overview.extract') })}
      ${button({ id: 'ri-brags-extract', variant: 'subtle', icon: 'sparkles', label: t('profile_import.brags.extract') })}
      ${button({ id: 'ri-typst-build', variant: 'subtle', icon: 'sparkles', label: t('profile_import.typst.build') })}
      ${spinnerRow({ id: 'ri-overview-status', staticLabel: t('profile_import.overview.status.generating') })}
      ${spinnerRow({ id: 'ri-brags-status', labelId: 'ri-brags-status-label' })}
      ${spinnerRow({ id: 'ri-typst-status', staticLabel: t('profile_import.typst.status.generating') })}
    </div>
    ${inlineError({ id: 'ri-overview-error' })}
    ${inlineError({ id: 'ri-brags-error' })}
    ${inlineError({ id: 'ri-typst-error' })}
  </div>
  <section id="ri-brags-review" class="hidden space-y-4"></section>
  <section id="ri-overview-review" class="hidden space-y-4"></section>
  <section id="ri-typst-review" class="hidden space-y-4"></section>`;

const setStatus = (label) => {
  const row = document.getElementById('ri-status');
  const l = document.getElementById('ri-status-label');
  if (!row || !l) return;
  if (!label) { row.classList.add('hidden'); return; }
  l.textContent = label;
  row.classList.remove('hidden');
};

const setError = (msg) => setInlineError('ri-error', msg);

const showResult = ({ kind, markdown, warnings }) => {
  const box = document.getElementById('ri-result');
  const kindEl = document.getElementById('ri-result-kind');
  const md = document.getElementById('ri-markdown');
  if (!box || !kindEl || !md) return;
  kindEl.textContent = kind;
  md.value = markdown || '';
  setInlineWarning('ri-warnings', warnings && warnings.length ? warnings.join(' · ') : '');
  box.classList.remove('hidden');
};

const handleFile = async (file) => {
  setError('');
  document.getElementById('ri-result')?.classList.add('hidden');

  if (file.size > MAX_BYTES) {
    setError(t('profile_import.error.too_large'));
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniff(bytes) === 'unknown') {
    setError(t('profile_import.error.unsupported'));
    return;
  }

  setStatus(t('profile_import.status.extracting'));
  try {
    const result = await extractResume(bytes);
    setStatus('');
    showResult(result);
  } catch (err) {
    setStatus('');
    setError(mapExtractError(err?.message || String(err)));
  }
};

// Translate a stable safety/extract error code into a user-facing message.
// Codes may carry a payload after ':' (e.g. `docx_forbidden:macros` or
// `pdf_active_content:/JS`) — used to pick a more specific i18n key.
const mapExtractError = (code) => {
  if (code === 'extract_timeout') return t('profile_import.error.timeout');
  if (code === 'unsupported_kind') return t('profile_import.error.unsupported');
  const [head, detail] = code.split(':', 2);
  if (head === 'pdf_active_content' && detail) {
    return t('profile_import.error.pdf_active_content', { key: detail });
  }
  if (head === 'docx_forbidden' && detail) {
    const key = `profile_import.error.docx_forbidden.${detail}`;
    const localized = t(key);
    if (localized !== key) return localized;
    return t('profile_import.error.generic', { error: code });
  }
  if (head === 'docx_zip_bomb_ratio' || head === 'docx_zip_bomb_total' || head === 'docx_stored_oversize') {
    return t('profile_import.error.docx_zip_bomb');
  }
  const key = `profile_import.error.${head}`;
  const localized = t(key);
  return localized === key ? t('profile_import.error.generic', { error: code }) : localized;
};

const wireUpload = () => {
  const input = document.getElementById('ri-file');
  if (!input) return;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) handleFile(f);
    input.value = '';
  });
};

// renderImport paints the import shell into ctx.mountEl. When the user
// clicks Back, ctx.onExit() is invoked so the caller can restore whatever
// view launched the flow.
export const renderImport = async (ctx) => {
  const { mountEl, onExit } = ctx;
  mountEl.innerHTML = `
    <div class="space-y-6">
      <header class="flex items-start justify-between gap-3">
        <div class="${CLS.textCol}">
          ${panelTitle(t('page.profile_import.title'))}
          <p class="${CLS.bodyText}">${escapeHtml(t('profile_import.subtitle'))}</p>
        </div>
        ${button({ id: 'ri-back', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('profile_import.back') })}
      </header>
      ${preflightBanner()}
      ${uploadHtml()}
      ${statusHtml()}
      ${resultHtml()}
    </div>`;
  wireUpload();
  wireBragsExtract(onExit);
  wireOverviewExtract(onExit);
  wireTypstBuild(onExit);
  document.getElementById('ri-back')?.addEventListener('click', () => onExit?.());
};
