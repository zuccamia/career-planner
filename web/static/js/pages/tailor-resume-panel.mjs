// Tailor slide-over: rank brags, draft, budget-clamp, hand off to editor
// prefilled with the tailored Typst.

import { CLS } from '../ui/classes.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { t, currentLocale } from '../i18n.mjs';
import { toast } from '../ui/toast.mjs';
import {
  badge, button, collapsible, emptyState, formField,
  helpText, inlineError, inlineWarning, panelTitle, setInlineError,
  subheadTitle,
} from '../ui/components.mjs';
import { openSlideOver, closeSlideOver, isSlideOverOpen } from '../ui/slide_over.mjs';
import { getApplication, parseTailorSignals, parsedJD, analyzeAndCacheRoleSignals } from '../entities/applications.mjs';
import { listResumes, getResume } from '../entities/resumes.mjs';
import { listBragEntries } from '../entities/brag-entries.mjs';
import { getOverview } from '../entities/profile-overview.mjs';
import { extractStructuredResumeFromSource } from '../rpc.mjs';
import { tailorResume } from '../tailor-client.mjs';
import { exceedsOnePage } from '../tailor/budget.mjs';
import { computeATSCoverage, keywordsInText } from '../tailor/coverage.mjs';
import { structuredToTypst } from '../workers/typst-render.mjs';
import { openResumePanel } from './profile-resume-panel.mjs';
import { createProgress, stepped } from '../ui/progress.mjs';

const PANEL_ID = 'tailor-resume-panel';

// Module-local state — cleared on close.
let currentApplication = null;
let resumesById = new Map();
let latestDraft = null; // { title, changes, base, atsKeywords, coverage, typst, overflow }
let bragsById = new Map();

const resetState = () => {
  currentApplication = null;
  resumesById = new Map();
  latestDraft = null;
  bragsById = new Map();
};

const profileForPrompt = (overview) => ({
  headline: overview?.headline || '',
  summary: overview?.summary || '',
  skills: overview?.skills || [],
  tools: overview?.tools || [],
});

const defaultTitle = (app) => {
  const role = app?.role_title || t('applications.role_untitled');
  const company = app?.company_name;
  return company
    ? t('applications.tailor.default_title_with_company', { role, company })
    : t('applications.tailor.default_title', { role });
};

// ---------- panel HTML ----------

const baseOptions = (resumes, selectedId) => resumes.map((row) => ({
  value: String(row.id),
  label: row.is_primary
    ? `${row.title || t('profile.resumes.untitled')} ★`
    : (row.title || t('profile.resumes.untitled')),
  selected: row.id === selectedId,
}));

const panelHtml = (app, resumes) => {
  const primary = resumes.find((r) => r.is_primary) ?? resumes[0];
  const noResumes = resumes.length === 0;
  const header = `${escapeHtml(app.company_name || t('applications.details.unknown_company'))} — ${escapeHtml(app.role_title || '')}`;
  return `
    <div class="${CLS.slideOverBody}">
      <header class="space-y-2">
        <div class="flex items-center justify-between gap-3">
          <p class="${CLS.eyebrow}">${escapeHtml(t('applications.tailor.panel.eyebrow'))}</p>
          ${button({ id: 'btn-tailor-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.close') })}
        </div>
        ${panelTitle(header)}
        ${helpText(t('applications.tailor.panel.help'))}
      </header>

      ${inlineError({ id: 'tailor-error' })}

      <section class="space-y-3">
        ${noResumes ? emptyState({ message: t('applications.tailor.field.base.empty') }) : `
          ${formField({
            type: 'select',
            name: 'tailor-base',
            label: t('applications.tailor.field.base.label'),
            options: baseOptions(resumes, primary?.id ?? null),
            hint: t('applications.tailor.field.base.hint'),
          })}
        `}
        <div class="${CLS.actionRowEnd}">
          ${button({ id: 'btn-tailor-generate', variant: 'primaryCompact', icon: 'sparkles', label: t('applications.tailor.action.generate'), disabled: noResumes })}
        </div>
        <div id="tailor-progress" class="hidden"></div>
      </section>

      <section id="tailor-result" class="hidden space-y-4"></section>
    </div>
  `;
};

const coverageStripHtml = (coverage) => {
  if (coverage.total === 0) return '';
  const percent = Math.round((coverage.present.length / coverage.total) * 100);
  const color = percent >= 80 ? 'emerald' : percent >= 50 ? 'brass' : 'slate';
  const countPill = badge({
    label: `${coverage.present.length}/${coverage.total}`, color, size: 'xs',
  });
  const missingChips = coverage.missing
    .map((kw) => badge({ label: kw, color: 'orange', size: 'xs', weight: 'medium' }))
    .join('');
  const missingBlock = coverage.missing.length
    ? collapsible({
        title: t('applications.tailor.result.coverage.missing_title', { count: coverage.missing.length }),
        summary: t('common.action.show'),
        openSummary: t('common.action.hide'),
        content: `<div class="mt-2 ${CLS.chipRow}">${missingChips}</div>`,
      })
    : `<p class="${CLS.tagline}">${escapeHtml(t('applications.tailor.result.coverage.all_present'))}</p>`;
  return `
    <div class="${CLS.card} space-y-2">
      <div class="flex items-center gap-2">
        ${countPill}
        ${subheadTitle(t('applications.tailor.result.coverage.title'))}
      </div>
      ${missingBlock}
    </div>
  `;
};

// Base-side lookup for the change's `before` context — the role/project name
// under which the change appears.
const entryHeading = (base, section, i) => {
  if (section === 'experience') {
    const r = base?.experience?.[i];
    if (!r) return '';
    const parts = [r.title, r.company].filter(Boolean);
    return parts.join(' — ');
  }
  if (section === 'projects') return base?.projects?.[i]?.name || '';
  if (section === 'activities') return base?.activities?.[i]?.name || '';
  return '';
};

const changeItemHtml = (change, opts) => {
  const { atsKeywords } = opts;
  const hits = keywordsInText(change.after, atsKeywords);
  const brag = change.brag_id ? bragsById.get(change.brag_id) : null;
  const sourceLabel = brag
    ? t('applications.tailor.result.change.from_brag', { title: brag.title || `#${brag.id}` })
    : t('applications.tailor.result.change.rephrase');
  const sourcePill = badge({
    label: sourceLabel, color: brag ? 'emerald' : 'slate', size: 'xs', weight: 'medium',
  });
  const citationChips = change.citations
    .map((c) => badge({ label: c, color: 'indigo', size: 'xs', weight: 'medium' }))
    .join('');
  const hitChips = hits
    .map((h) => badge({ label: h, color: 'slate', size: 'xs', weight: 'medium' }))
    .join('');
  return `
    <div class="rounded-xl border border-line bg-paper p-3 space-y-2">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="space-y-1">
          <p class="${CLS.eyebrowFaint}">${escapeHtml(t('applications.tailor.result.change.before'))}</p>
          <p class="${CLS.bodyText} text-ink-faint line-through">${escapeHtml(change.before)}</p>
        </div>
        <div class="space-y-1">
          <p class="${CLS.eyebrowFaint}">${escapeHtml(t('applications.tailor.result.change.after'))}</p>
          <p class="${CLS.bodyText}">${escapeHtml(change.after)}</p>
        </div>
      </div>
      ${change.reasoning ? `
        <p class="${CLS.helpText}">${escapeHtml(t('applications.tailor.result.change.reasoning'))}: ${escapeHtml(change.reasoning)}</p>` : ''}
      <div class="${CLS.chipRowInline}">
        ${sourcePill}
        ${citationChips ? `<span class="${CLS.helpText}">${escapeHtml(t('applications.tailor.result.change.cites'))}</span>${citationChips}` : ''}
      </div>
      ${hits.length ? `
        <div class="${CLS.chipRowInline}">
          <span class="${CLS.helpText}">${escapeHtml(t('applications.tailor.result.change.hits'))}</span>
          ${hitChips}
        </div>` : ''}
    </div>
  `;
};

const sectionDiffHtml = (section, changes, opts) => {
  if (!changes.length) return '';
  // Group by entry_index so the role/project heading renders once per entry.
  const byEntry = new Map();
  for (const c of changes) {
    if (!byEntry.has(c.entry_index)) byEntry.set(c.entry_index, []);
    byEntry.get(c.entry_index).push(c);
  }
  const entries = Array.from(byEntry.entries()).sort(([a], [b]) => a - b);
  const html = entries.map(([idx, items]) => {
    const heading = entryHeading(opts.base, section, idx);
    return `
      <div class="space-y-2">
        ${heading ? `<p class="${CLS.eyebrow}">${escapeHtml(heading)}</p>` : ''}
        <div class="space-y-2">${items.map((c) => changeItemHtml(c, opts)).join('')}</div>
      </div>`;
  }).join('');
  return `
    <section class="space-y-3">
      ${subheadTitle(t(`applications.tailor.result.section.${section}`))}
      ${html}
    </section>`;
};

// Filter reorder-leaks: `after` matches another base bullet in the same entry.
const norm = (s) => String(s ?? '').trim().toLowerCase();

const baseBulletTexts = (base, section, entryIdx) => {
  if (section === 'experience') {
    return (base?.experience?.[entryIdx]?.bullets ?? []).map((b) => b?.description);
  }
  const entry = base?.[section]?.[entryIdx];
  return entry?.description ? [entry.description] : [];
};

const isReorderNoise = (change, base) => {
  const siblings = baseBulletTexts(base, change.section, change.entry_index);
  const after = norm(change.after);
  const beforeIdx = change.bullet_index ?? -1;
  // A move: `after` matches some OTHER base bullet in the same entry (not the
  // one at this slot). Same-slot identity is already filtered as no-op by the
  // parser's before !== after guard.
  return siblings.some((text, i) => i !== beforeIdx && norm(text) === after);
};

const groupChangesBySection = (changes, base) => {
  const out = { experience: [], projects: [], activities: [] };
  for (const c of changes ?? []) {
    if (!out[c.section]) continue;
    if (isReorderNoise(c, base)) continue;
    out[c.section].push(c);
  }
  return out;
};

const resultSectionHtml = (draft) => {
  const overflow = draft.overflow
    ? inlineWarning({ id: 'tailor-overflow', message: t('applications.tailor.result.overflow') })
    : '';
  const grouped = groupChangesBySection(draft.changes, draft.base);
  const hasAnyChange = draft.changes?.length > 0;
  const renderOpts = { base: draft.base, atsKeywords: draft.atsKeywords };
  const diffs = hasAnyChange
    ? [
        sectionDiffHtml('experience', grouped.experience, renderOpts),
        sectionDiffHtml('projects', grouped.projects, renderOpts),
        sectionDiffHtml('activities', grouped.activities, renderOpts),
      ].filter(Boolean).join('')
    : emptyState({ message: t('applications.tailor.result.no_changes') });
  return `
    ${overflow}
    ${coverageStripHtml(draft.coverage)}
    ${diffs}
    <div class="${CLS.actionRowEnd}">
      ${button({ id: 'btn-tailor-open-draft', variant: 'primaryCompact', icon: 'edit', label: t('applications.tailor.action.open_draft') })}
    </div>
  `;
};

// ---------- orchestrator ----------

const readSelectedBaseId = () => {
  const sel = document.querySelector('select[name="tailor-base"]');
  return sel ? Number(sel.value) || null : null;
};

// Synthesize `### ATS keywords` section into the rubric for the tailor LLM.
const signalsWithATS = ({ signals, ats_keywords }) => {
  if (!ats_keywords?.length) return signals || '';
  const bullets = ats_keywords.map((kw) => `- ${kw}`).join('\n');
  const base = (signals || '').trimEnd();
  return `${base}\n\n### ATS keywords\n${bullets}`;
};

const runTailor = async () => {
  setInlineError('tailor-error', '');
  // Clear stale result UI before regenerate.
  const priorResult = document.getElementById('tailor-result');
  if (priorResult) {
    priorResult.innerHTML = '';
    priorResult.classList.add('hidden');
  }
  const baseId = readSelectedBaseId();
  const base = baseId ? resumesById.get(baseId) : null;
  if (!base) {
    setInlineError('tailor-error', t('applications.tailor.field.base.empty'));
    return;
  }
  const brags = Array.from(bragsById.values());
  if (!brags.length) {
    setInlineError('tailor-error', t('applications.tailor.error.no_brags'));
    return;
  }
  const jd = parsedJD(currentApplication);
  if (!jd) {
    setInlineError('tailor-error', t('applications.tailor.needs_jd'));
    return;
  }
  const generateBtn = document.getElementById('btn-tailor-generate');
  if (generateBtn) generateBtn.disabled = true;
  const progress = createProgress(document.getElementById('tailor-progress'));
  progress.reset();
  const step = progress.asCallback();
  const locale = currentLocale();
  try {
    const overview = await getOverview();
    const profile = profileForPrompt(overview);

    // Derive signals if missing (user can review it later on the Analyze slide-over).
    let envelope = parseTailorSignals(currentApplication.tailor_signals);
    if (!envelope.signals && !envelope.ats_keywords.length) {
      envelope = await stepped(step, 'analyze_role', () => analyzeAndCacheRoleSignals(currentApplication, jd, locale));
    }
    const signals = signalsWithATS(envelope);

    const baseWithBody = await getResume(baseId);
    const baseStructured = await stepped(step, 'parse_base',
      () => extractStructuredResumeFromSource(baseWithBody.body, locale));

    const tailored = await tailorResume({
      jd_structured: jd,
      profile,
      base_resume_structured: baseStructured,
      role_signals: signals,
      brags,
    }, { locale, onStep: step });

    const overflow = exceedsOnePage(tailored.resume, baseStructured);
    const typst = structuredToTypst(tailored.resume);
    const title = defaultTitle(currentApplication);
    const coverage = computeATSCoverage(tailored.resume, envelope.ats_keywords);

    latestDraft = {
      title,
      changes: tailored.changes,
      base: baseStructured,
      atsKeywords: envelope.ats_keywords,
      coverage,
      typst,
      overflow,
    };

    const resultEl = document.getElementById('tailor-result');
    if (resultEl) {
      resultEl.innerHTML = resultSectionHtml(latestDraft);
      resultEl.classList.remove('hidden');
      document.getElementById('btn-tailor-open-draft')?.addEventListener('click', openDraftInEditor);
    }
  } catch (err) {
    setInlineError('tailor-error', t('applications.tailor.error.generic', { err: err?.message || String(err) }));
  } finally {
    if (generateBtn) generateBtn.disabled = false;
  }
};

const openDraftInEditor = () => {
  if (!latestDraft) return;
  const applicationId = currentApplication?.id ?? null;
  const draft = latestDraft;
  // Stack the résumé editor on top of this panel — closing it drops the user
  // back to the tailor result view (coverage + per-section diffs) instead of
  // the application detail page.
  openResumePanel({
    initialResume: {
      title: draft.title,
      format: 'typ',
      body: draft.typst,
      applicationId,
    },
  });
};

// ---------- public entry ----------

export const openTailorResumePanel = async ({ applicationId, triggerEl = null, onClose } = {}) => {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  if (isSlideOverOpen(PANEL_ID)) closeSlideOver(PANEL_ID);

  const app = await getApplication(applicationId);
  if (!app) {
    toast(t('applications.error.not_found', { id: applicationId }), 'error');
    return;
  }
  const [resumes, brags] = await Promise.all([listResumes(), listBragEntries()]);
  currentApplication = app;
  resumesById = new Map(resumes.map((row) => [row.id, row]));
  bragsById = new Map(brags.map((row) => [row.id, row]));

  panel.innerHTML = panelHtml(app, resumes);
  openSlideOver({
    panelId: PANEL_ID,
    trigger: triggerEl,
    onClose: () => {
      resetState();
      if (onClose) onClose();
    },
  });

  document.getElementById('btn-tailor-close')?.addEventListener('click', () => closeSlideOver(PANEL_ID));
  document.getElementById('btn-tailor-generate')?.addEventListener('click', () => runTailor());
};
