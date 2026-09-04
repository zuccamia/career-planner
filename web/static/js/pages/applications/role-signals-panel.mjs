// Role-signals slide-over. Reads/derives the cached role brief; hands off
// to the tailor panel on continue.

import { CLS } from '../../ui/classes.mjs';
import { escapeHtml } from '../../ui/dom.mjs';
import { t, currentLocale } from '../../i18n.mjs';
import { toast } from '../../ui/toast.mjs';
import {
  badge, button, emptyState, helpText, inlineError, panelTitle, setInlineError, subheadTitle,
} from '../../ui/components.mjs';
import { openSlideOver, closeSlideOver, isSlideOverOpen } from '../../ui/slide_over.mjs';
import { createProgress } from '../../ui/progress.mjs';
import {
  getApplication, parseRoleSignals, parsedJD,
  analyzeAndCacheRoleSignals,
  parseProfileFit, analyzeAndCacheProfileFit,
} from '../../entities/applications.mjs';
import { renderMarkdown } from '../../ui/markdown.mjs';
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
  const envelope = parseRoleSignals(app?.role_signals);
  const fitEnvelope = parseProfileFit(app?.profile_fit);
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
        ${hasSignals ? '' : emptyStateActionsHtml()}
        ${helpText(t('applications.signals.panel.help'))}
        ${hasSignals ? headerActionsHtml() : ''}
      </header>

      <div id="signals-progress" class="hidden"></div>
      ${inlineError({ id: 'signals-error' })}

      <section id="signals-body" class="space-y-3">
        ${signalsBodyHtml(envelope)}
      </section>

      <section id="fit-body" class="space-y-3">
        ${fitSectionHtml(fitEnvelope)}
      </section>
    </div>
  `;
};

// Regenerate + Continue-to-tailor live under the title when signals exist.
const headerActionsHtml = () => `
  <div class="${CLS.actionRowEnd} pt-1">
    ${button({ id: 'btn-signals-regenerate', variant: 'secondaryCompact', icon: 'arrowPath', label: t('applications.signals.action.regenerate') })}
    ${button({ id: 'btn-signals-continue-tailor', variant: 'primaryCompact', icon: 'sparkles', label: t('applications.action.tailor_resume') })}
  </div>
`;

// Analyze sits above the tagline in the empty state so the primary action is
// the first thing the user sees, before the descriptive help text.
const emptyStateActionsHtml = () => `
  <div class="${CLS.actionRowEnd} pt-1">
    ${button({ id: 'btn-signals-analyze', variant: 'primaryCompact', icon: 'sparkles', label: t('applications.signals.action.analyze') })}
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
    return emptyState({ message: t('applications.signals.empty') });
  }
  return `
    ${subheadTitle(t('applications.signals.section.title'))}
    ${signals ? `<div class="${CLS.bodyText} prose-signals">${renderMarkdown(signals)}</div>` : ''}
    ${atsKeywordsHtml(ats_keywords)}
  `;
};

// "Your fit" — filled by the panel's Analyze / Regenerate. No section-level
// trigger; fit is always co-derived with role signals.
const fitSectionHtml = ({ fit }) => {
  const heading = subheadTitle(t('applications.fit.section.title'));
  if (!fit) {
    return `
      ${heading}
      ${emptyState({ message: t('applications.fit.empty') })}
    `;
  }
  return `
    ${heading}
    <div class="${CLS.bodyText} prose-signals">${renderMarkdown(fit)}</div>
  `;
};

// ---------- orchestrator ----------

// Analyze / Regenerate runs role-signals first, then feeds its envelope into
// analyze-fit. Two progress rows tick in sequence. If signals fails, fit is
// skipped (nothing to anchor it).
const runAll = async () => {
  if (!currentApplication) return;
  setInlineError('signals-error', '');
  const jd = parsedJD(currentApplication);
  if (!jd) {
    setInlineError('signals-error', t('applications.tailor.needs_jd'));
    return;
  }
  const buttons = ['btn-signals-analyze', 'btn-signals-regenerate']
    .map((id) => document.getElementById(id)).filter(Boolean);
  buttons.forEach((el) => { el.disabled = true; });
  const progress = createProgress(document.getElementById('signals-progress'));
  progress.reset();
  progress.start('role_signals', 'applications.signals.progress.role_signals');
  const locale = currentLocale();
  let signalsEnvelope = null;
  let fitError = null;
  try {
    signalsEnvelope = await analyzeAndCacheRoleSignals(currentApplication, jd, locale);
    progress.complete('role_signals');
    if (signalsEnvelope.signals || signalsEnvelope.ats_keywords.length) closingReport.derived = true;
  } catch (err) {
    progress.fail('role_signals', err);
    setInlineError('signals-error', t('applications.signals.error.generic', { err: err?.message || String(err) }));
  }
  if (signalsEnvelope && signalsEnvelope.signals) {
    progress.start('profile_fit', 'applications.signals.progress.profile_fit');
    try {
      const fitEnvelope = await analyzeAndCacheProfileFit(currentApplication, signalsEnvelope, locale);
      progress.complete('profile_fit');
      if (fitEnvelope.fit) closingReport.derivedFit = true;
    } catch (err) {
      progress.fail('profile_fit', err);
      fitError = err;
    }
  }
  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    panel.innerHTML = bodyHtml(currentApplication);
    wireActionButtons();
  }
  if (fitError && !document.getElementById('signals-error')?.textContent) {
    setInlineError('signals-error', t('applications.fit.error.generic', { err: fitError?.message || String(fitError) }));
  }
};

const wireActionButtons = () => {
  document.getElementById('btn-signals-analyze')?.addEventListener('click', runAll);
  document.getElementById('btn-signals-regenerate')?.addEventListener('click', runAll);
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
  closingReport = { derived: false, derivedFit: false };
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
