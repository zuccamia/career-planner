// Role-signals slide-over. Reads/derives the cached role brief; hands off
// to the tailor panel on continue.

import { CLS } from '../ui/classes.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { t, currentLocale } from '../i18n.mjs';
import { toast } from '../ui/toast.mjs';
import {
  badge, button, emptyState, helpText, inlineError, panelTitle, setInlineError, subheadTitle,
} from '../ui/components.mjs';
import { openSlideOver, closeSlideOver, isSlideOverOpen } from '../ui/slide_over.mjs';
import { getApplication, parseTailorSignals, parsedJD, analyzeAndCacheRoleSignals } from '../entities/applications.mjs';
import { renderMarkdown } from '../ui/markdown.mjs';
import { openTailorResumePanel } from './tailor-resume-panel.mjs';

const PANEL_ID = 'role-signals-panel';

// Module-local state — cleared on close.
let currentApplication = null;
let closingReport = null;

const resetState = () => {
  currentApplication = null;
  closingReport = null;
};

// ---------- panel HTML ----------

const bodyHtml = (app) => {
  const envelope = parseTailorSignals(app?.tailor_signals);
  const header = `${escapeHtml(app.company_name || t('applications.details.unknown_company'))} — ${escapeHtml(app.role_title || '')}`;
  const hasSignals = envelope.signals || envelope.ats_keywords?.length;
  return `
    <div class="${CLS.slideOverBody}">
      <header class="space-y-2">
        <div class="flex items-center justify-between gap-3">
          <p class="${CLS.eyebrow}">${escapeHtml(t('applications.signals.panel.eyebrow'))}</p>
          ${button({ id: 'btn-signals-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.close') })}
        </div>
        ${panelTitle(header)}
        ${helpText(t('applications.signals.panel.help'))}
        ${hasSignals ? headerActionsHtml() : ''}
      </header>

      <p id="signals-status" class="${CLS.helpText}"></p>
      ${inlineError({ id: 'signals-error' })}

      <section id="signals-body" class="space-y-3">
        ${signalsBodyHtml(envelope)}
      </section>
    </div>
  `;
};

// Regenerate + Continue-to-tailor live under the title when signals exist.
// In the empty state we surface Analyze at the bottom instead.
const headerActionsHtml = () => `
  <div class="${CLS.actionRowEnd} pt-1">
    ${button({ id: 'btn-signals-regenerate', variant: 'secondaryCompact', icon: 'arrowPath', label: t('applications.signals.action.regenerate') })}
    ${button({ id: 'btn-signals-continue-tailor', variant: 'primaryCompact', icon: 'sparkles', label: t('applications.action.tailor_resume') })}
  </div>
`;

const atsKeywordsHtml = (keywords) => {
  if (!keywords?.length) return '';
  const pills = keywords
    .map((kw) => badge({ label: kw, color: 'slate', size: 'xs', weight: 'medium' }))
    .join('');
  return `
    <div class="space-y-2">
      ${subheadTitle(t('applications.signals.section.ats_keywords'))}
      <div class="${CLS.chipRow}">${pills}</div>
    </div>
  `;
};

const signalsBodyHtml = ({ signals, ats_keywords }) => {
  if (!signals && !ats_keywords?.length) {
    return `
      ${emptyState({ message: t('applications.signals.empty') })}
      <div class="${CLS.actionRowEnd}">
        ${button({ id: 'btn-signals-analyze', variant: 'primaryCompact', icon: 'sparkles', label: t('applications.signals.action.analyze') })}
      </div>
    `;
  }
  return `
    ${signals ? `<div class="${CLS.bodyText} prose-signals">${renderMarkdown(signals)}</div>` : ''}
    ${atsKeywordsHtml(ats_keywords)}
  `;
};

// ---------- orchestrator ----------

const setStatus = (msg) => {
  const el = document.getElementById('signals-status');
  if (el) el.textContent = msg || '';
};

const runDerive = async () => {
  if (!currentApplication) return;
  setInlineError('signals-error', '');
  const jd = parsedJD(currentApplication);
  if (!jd) {
    setInlineError('signals-error', t('applications.tailor.needs_jd'));
    return;
  }
  const analyzeBtn = document.getElementById('btn-signals-analyze');
  const regenBtn = document.getElementById('btn-signals-regenerate');
  if (analyzeBtn) analyzeBtn.disabled = true;
  if (regenBtn) regenBtn.disabled = true;
  setStatus(t('applications.signals.status.analyzing'));
  try {
    const envelope = await analyzeAndCacheRoleSignals(currentApplication, jd, currentLocale());
    if (envelope.signals || envelope.ats_keywords.length) {
      closingReport.derived = true;
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.innerHTML = bodyHtml(currentApplication);
        wireActionButtons();
      }
    }
    setStatus('');
  } catch (err) {
    setInlineError('signals-error', t('applications.signals.error.generic', { err: err?.message || String(err) }));
  } finally {
    if (analyzeBtn) analyzeBtn.disabled = false;
    if (regenBtn) regenBtn.disabled = false;
  }
};

const wireActionButtons = () => {
  document.getElementById('btn-signals-analyze')?.addEventListener('click', runDerive);
  document.getElementById('btn-signals-regenerate')?.addEventListener('click', runDerive);
  document.getElementById('btn-signals-close')?.addEventListener('click', () => closeSlideOver(PANEL_ID));
  document.getElementById('btn-signals-continue-tailor')?.addEventListener('click', () => {
    const applicationId = currentApplication?.id;
    if (!applicationId) return;
    closeSlideOver(PANEL_ID);
    openTailorResumePanel({ applicationId });
  });
};

// ---------- public entry ----------

export const openRoleSignalsPanel = async ({ applicationId, triggerEl = null, onClose } = {}) => {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  if (isSlideOverOpen(PANEL_ID)) closeSlideOver(PANEL_ID);

  const app = await getApplication(applicationId);
  if (!app) {
    toast(t('applications.error.not_found', { id: applicationId }), 'error');
    return;
  }
  currentApplication = app;
  closingReport = { derived: false };
  panel.innerHTML = bodyHtml(app);
  openSlideOver({
    panelId: PANEL_ID,
    trigger: triggerEl,
    onClose: () => {
      const report = { ...closingReport };
      resetState();
      if (onClose) onClose(report);
    },
  });
  wireActionButtons();
};
