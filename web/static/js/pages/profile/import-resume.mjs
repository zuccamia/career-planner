// Typst-résumé build + preview + save flow for the résumé import view.
// Deterministic renderer lives in workers/typst-render.mjs.

import { CLS } from '../../ui/classes.mjs';
import { button, helpText, inlineError, setInlineError, subheadTitle } from '../../ui/components.mjs';
import { t, currentLocale } from '../../i18n.mjs';
import { toast } from '../../ui/toast.mjs';
import { extractStructuredResumeFromSource } from '../../rpc.mjs';
import { createResume, getOverview } from '../../entities/profile.mjs';
import { compileTypstToPdf } from '../../workers/typst-client.mjs';
import { structuredToTypst } from '../../workers/typst-render.mjs';

// ---------- build + preview + save flow ----------

// Working payload during the review step. Mutable so pdfUrl can be revoked
// on rebuild without threading the reference through every callsite.
let typstState = null;

const setTypstStatus = (visible) => {
  const el = document.getElementById('ri-typst-status');
  if (el) el.classList.toggle('hidden', !visible);
};
const setTypstError = (msg) => setInlineError('ri-typst-error', msg);

const compileAndRenderPreview = async () => {
  const srcEl = document.getElementById('ri-typst-source');
  const frame = document.getElementById('ri-typst-preview');
  const rebuildBtn = document.getElementById('ri-typst-rebuild');
  if (!srcEl || !frame) return;
  setInlineError('ri-typst-compile-error', '');
  if (rebuildBtn) rebuildBtn.disabled = true;
  try {
    const { pdf } = await compileTypstToPdf(srcEl.value);
    if (typstState?.pdfUrl) URL.revokeObjectURL(typstState.pdfUrl);
    const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    typstState.pdfUrl = url;
    frame.src = url;
  } catch (err) {
    setInlineError('ri-typst-compile-error', t('profile_import.typst.error.compile', { error: err?.message || String(err) }));
  } finally {
    if (rebuildBtn) rebuildBtn.disabled = false;
  }
};

const saveTypstResume = async (onExit) => {
  const srcEl = document.getElementById('ri-typst-source');
  if (!srcEl || !typstState) return;
  const btn = document.getElementById('ri-typst-save');
  setInlineError('ri-typst-save-error', '');
  if (btn) btn.disabled = true;
  try {
    await createResume({
      title: typstState.title,
      format: 'typ',
      body: srcEl.value,
    });
    toast(t('profile_import.typst.saved', { title: typstState.title }), 'ok');
    if (typstState.pdfUrl) URL.revokeObjectURL(typstState.pdfUrl);
    onExit?.('resumes');
  } catch (err) {
    setInlineError('ri-typst-save-error', t('profile_import.typst.error.generic', { error: err?.message || String(err) }));
  } finally {
    if (btn) btn.disabled = false;
  }
};

const renderTypstReview = (source, title, onExit) => {
  const el = document.getElementById('ri-typst-review');
  if (!el) return;
  typstState = { source, title, pdfUrl: null };
  el.innerHTML = `
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        ${subheadTitle(t('profile_import.typst.review.title'))}
        ${helpText(t('profile_import.typst.review.hint'))}
      </div>
      <div class="${CLS.formRow} shrink-0">
        ${button({ id: 'ri-typst-rebuild', variant: 'secondaryCompact', icon: 'document', label: t('profile_import.typst.rebuild') })}
        ${button({ id: 'ri-typst-save', variant: 'primaryCompact', icon: 'check', label: t('profile_import.typst.save') })}
      </div>
    </div>
    ${inlineError({ id: 'ri-typst-compile-error' })}
    ${inlineError({ id: 'ri-typst-save-error' })}
    <div class="${CLS.gridTwoCol} gap-4">
      <textarea id="ri-typst-source" spellcheck="false"
                class="${CLS.textarea} ${CLS.codeText} min-h-[60vh] max-h-[80vh] resize-y"></textarea>
      <iframe id="ri-typst-preview" title="Typst preview"
              class="min-h-[60vh] w-full rounded-2xl border border-line bg-surface"></iframe>
    </div>`;
  document.getElementById('ri-typst-source').value = source;
  el.classList.remove('hidden');
  document.getElementById('ri-typst-rebuild')?.addEventListener('click', () => compileAndRenderPreview());
  document.getElementById('ri-typst-save')?.addEventListener('click', () => saveTypstResume(onExit));
  compileAndRenderPreview();
};

const runTypstBuild = async (onExit) => {
  const md = document.getElementById('ri-markdown')?.value?.trim();
  if (!md) {
    setTypstError(t('profile_import.error.unsupported'));
    return;
  }
  setTypstError('');
  const btn = document.getElementById('ri-typst-build');
  if (btn) btn.disabled = true;
  setTypstStatus(true);
  try {
    const [structured, existingOverview] = await Promise.all([
      extractStructuredResumeFromSource(md, currentLocale()),
      getOverview(),
    ]);
    const source = structuredToTypst(structured || {});
    // Title precedence: name the LLM pulled from the CV → the name already
    // on the profile → localized "Imported CV" fallback.
    const namePart = (structured?.contact?.name?.trim()) || (existingOverview?.name?.trim());
    const title = namePart ? `${namePart} — CV` : t('profile_import.typst.default_title');
    renderTypstReview(source, title, onExit);
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('no_llm_configured') || msg.includes('setup')) {
      setTypstError(t('profile_import.typst.error.no_llm'));
    } else {
      setTypstError(t('profile_import.typst.error.generic', { error: msg }));
    }
  } finally {
    setTypstStatus(false);
    if (btn) btn.disabled = false;
  }
};

export const wireTypstBuild = (onExit) => {
  const btn = document.getElementById('ri-typst-build');
  if (!btn) return;
  btn.addEventListener('click', () => runTypstBuild(onExit));
};
