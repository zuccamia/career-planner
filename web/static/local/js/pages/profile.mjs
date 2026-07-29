// Career profile page — Overview (name/headline/summary + sparks),
// Resumes (markdown or Typst source; Typst compiles to PDF via typst.ts
// and can be attached to an application), Brag Sheet.
//
// First run: if profile_overview.onboarded_at is NULL and everything is
// empty, the Overview tab renders a themed reflection wizard instead of the
// flat form. Steps 4–6 build up the sparks list.

import { CLS } from '../ui/classes.mjs';
import { escapeHtml, formatDate, formatBytes } from '../ui/dom.mjs';
import { button, pageHeader, formField, emptyState, inlineError, setInlineError, badge, tab, chip, removablePill } from '../ui/components.mjs';
import { toast } from '../ui/toast.mjs';
import { t } from '../i18n.mjs';
import {
  getOverview, updateOverview, markOnboarded, clearOnboarded, SKILL_LEVELS,
} from '../entities/profile-overview.mjs';
import {
  listSparks, createSpark, deleteSpark, countSparks,
} from '../entities/career-sparks.mjs';
import {
  listResumes, getResume, createResume, updateResume, deleteResume, setPrimaryResume, countResumes,
} from '../entities/resumes.mjs';
import {
  listBragEntries, createBragEntry, updateBragEntry, deleteBragEntry, countBragEntries,
} from '../entities/brag-entries.mjs';
import { listPdfsForResume, linkPdfToApplication } from '../entities/resume-pdfs.mjs';
import { listApplications } from '../entities/applications.mjs';
import { listCompanies } from '../entities/companies.mjs';
import { generateBragTags } from '../rpc.mjs';
import { uploadAttachment, sanitizeFolder } from '../storage/attachments.mjs';
import { compileTypstToPdf } from '../workers/typst-client.mjs';

// Tab identity + display label in one place — order determines tab-strip
// order (relying on JS insertion order for object keys, guaranteed since ES2015).
// Values are i18n keys resolved at render time (t() bundle isn't ready at
// module load).
const TABS = {
  overview: 'profile.tab.overview',
  resumes: 'profile.tab.resumes',
  brag: 'profile.tab.brag_sheet',
};
const TAB_NAMES = Object.keys(TABS);
const CURRENT_YEAR = String(new Date().getFullYear());

// ---------- state ----------

const state = {
  tab: 'overview',
  wizardStep: 0,
  wizardOverview: { name: '', headline: '', summary: '', skills: [] },
  // Sparks the user added in each themed wizard step, keyed by step number.
  // Only these ids are shown on that step's screen — collected sparks from
  // other steps stay hidden until the recap, so each theme feels focused.
  wizardSparkIds: { 5: [], 6: [], 7: [] },
  resumeEditorId: null,
  resumeEditorNew: false,
  resumePdfBlob: null,
  resumePdfUrl: null,
  bragEditorId: null,
  bragEditorNew: false,
  // Brag tags are editable inside the unsaved brag-entry form: the user can
  // generate, add, or remove tags before clicking Save. Keep both the working
  // tag list and any newly-generated timestamp in page state until submit.
  bragDraftTags: [],
  bragPendingTagsGeneratedAt: null,
};

// ---------- shell ----------

const shellHtml = () => `
  <div class="space-y-6">
    <div id="toast" class="hidden"></div>
    <section class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      ${pageHeader({ title: t('page.profile.title'), tagline: t('profile.tagline') })}
    </section>

    <div class="border-b border-slate-200">
      <nav class="flex gap-1" role="tablist" id="tab-strip">
        ${TAB_NAMES.map(t => tabButton(t)).join('')}
      </nav>
    </div>

    <section id="tab-content"></section>
  </div>
`;

const tabButton = (name) => tab({
  label: t(TABS[name]),
  name,
  active: state.tab === name,
});

const syncTabInUrl = (tab) => {
  const url = new URL(window.location.href);
  if (tab === 'overview') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
};

const setTab = (tab) => {
  if (!TAB_NAMES.includes(tab)) tab = 'overview';
  state.tab = tab;
  syncTabInUrl(tab);
  document.getElementById('tab-strip').innerHTML = TAB_NAMES.map(t => tabButton(t)).join('');
  wireTabStrip();
  refreshProfileTabCounts();
  renderTab();
};

// Populate the resumes/brag counter pills on the tab strip. Same shape as
// ui/sidebar_counts — count = 0 hides the pill; count > 0 shows a slate
// number bubble. Overview isn't a list so no counter for it.
const refreshProfileTabCounts = async () => {
  const [resumes, brags] = await Promise.all([countResumes(), countBragEntries()]);
  setTabCount('resumes', resumes);
  setTabCount('brag', brags);
};

const setTabCount = (name, n) => {
  const el = document.querySelector(`[data-tab-count="${name}"]`);
  if (!el) return;
  if (n > 0) {
    el.textContent = String(n);
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
};

const renderTab = () => {
  const el = document.getElementById('tab-content');
  if (!el) return;
  if (state.tab === 'overview') return renderOverviewTab(el);
  if (state.tab === 'resumes') return renderResumesTab(el);
  if (state.tab === 'brag') return renderBragTab(el);
};

const wireTabStrip = () => {
  document.querySelectorAll('.js-tab').forEach(b => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  });
};

// ============================================================================
// OVERVIEW TAB
// ============================================================================

const renderOverviewTab = async (el) => {
  el.innerHTML = `<p class="text-sm text-slate-500">${t('app.loading')}</p>`;
  const [overview, sparkCount] = await Promise.all([getOverview(), countSparks()]);
  const isFirstRun =
    !overview?.onboarded_at &&
    !(overview?.name || '').trim() &&
    !(overview?.headline || '').trim() &&
    !(overview?.summary || '').trim() &&
    sparkCount === 0;
  if (isFirstRun) {
    state.wizardStep = 1;
    state.wizardOverview = {
      name: overview?.name || '',
      headline: overview?.headline || '',
      summary: overview?.summary || '',
      skills: overview?.skills || [],
    };
    state.wizardSparkIds = { 5: [], 6: [], 7: [] };
    renderWizard(el);
  } else {
    renderOverviewFlat(el, overview);
  }
};

// ---------- flat form ----------

const renderOverviewFlat = async (el, overview) => {
  const sparks = await listSparks();
  el.innerHTML = `
    <div class="space-y-6">
      <div class="${CLS.card}">
        <div class="flex items-baseline justify-between">
          <p class="${CLS.eyebrow}">${t('profile.overview.about_eyebrow')}</p>
          ${button({ id: 'btn-redo-intro', variant: 'primaryCompact', icon: 'arrowPath', label: t('profile.action.redo_intro') })}
        </div>
        ${inlineError({ id: 'overview-error' })}
        <div class="grid gap-4">
          ${formField({ type: 'text', name: 'ov-name', label: t('profile.field.name.label'),
                        value: overview?.name || '', placeholder: t('profile.field.name.placeholder'),
                        dataset: { field: 'name' } })}
          ${formField({ type: 'text', name: 'ov-headline', label: t('profile.field.headline.label'),
                        value: overview?.headline || '',
                        placeholder: t('profile.field.headline.placeholder'),
                        hint: t('profile.field.headline.hint'),
                        dataset: { field: 'headline' } })}
          ${formField({ type: 'textarea', name: 'ov-summary', label: t('profile.field.summary.label'),
                        value: overview?.summary || '', rows: 6,
                        placeholder: t('profile.field.summary.placeholder'),
                        dataset: { field: 'summary' } })}
          <div class="grid gap-2">
            <label class="${CLS.label}">${t('profile.skills.label')}</label>
            ${skillsEditorHtml({ mountId: 'ov-skills-editor', skills: overview?.skills || [] })}
            <p class="text-xs text-slate-500">${t('profile.skills.help')}</p>
          </div>
        </div>
      </div>

      <div class="${CLS.card}">
        <div class="flex items-baseline justify-between">
          <div>
            <p class="${CLS.eyebrow}">${t('profile.sparks.eyebrow')}</p>
            <p class="mt-1 text-sm text-slate-500">${t('profile.sparks.help')}</p>
          </div>
        </div>
        <div id="sparks-list" class="space-y-2">${sparksListHtml(sparks)}</div>
        ${sparkInputHtml()}
      </div>
    </div>
  `;
  wireOverviewFlat();
};

const sparksListHtml = (sparks) => {
  if (!sparks.length) {
    return `<p class="text-sm text-slate-400">${t('profile.sparks.empty')}</p>`;
  }
  // "Top priority" = the smallest sort_order present. Any spark at that tier
  // (there may be several tied) is highlighted; the rest render muted.
  const topSort = Math.min(...sparks.map(s => Number(s.sort_order ?? 0)));
  return `<div class="flex flex-wrap gap-2">${sparks.map(s => sparkPillHtml(s, Number(s.sort_order ?? 0) === topSort)).join('')}</div>`;
};

// Sparks reuse the shared badge() component with a custom body — same visual
// language as brag-entry tags, application status pills, etc. The × button
// deletes. Sparks at the top-priority tier render in the prominent blue
// palette; the rest use slate so the eye lands on the top tier first.
const sparkPillHtml = (s, isTopTier) => {
  const idAttr = { 'spark-id': String(s.id) };
  return removablePill({
    label: s.body || '(empty)',
    color: isTopTier ? 'blue' : 'slate',
    classes: 'gap-1.5',
    dataset: idAttr,
    dismissClass: 'js-spark-delete',
    dismissLabel: t('profile.sparks.aria.remove'),
  });
};

const bragTagPillHtml = (tag) => {
  return removablePill({
    label: tag,
    color: 'slate',
    classes: 'gap-1.5',
    dataset: { tag },
    dismissClass: 'js-brag-tag-delete',
    dismissLabel: `Remove tag ${tag}`,
  });
};

// A single input row that appends a new spark on Enter. Priority (1 = top,
// higher = lower priority) is stored as sort_order — ties allowed so the user
// can mark several sparks as equally top-tier. Default priority is 3
// (middle) so the first spark added isn't automatically the top.
const sparkInputHtml = () => `
  <div class="flex items-center gap-2">
    <input id="spark-input" type="text" placeholder="${t('profile.sparks.placeholder')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
    <select id="spark-priority" title="${t('profile.sparks.priority_title')}" class="${CLS.inputBase} w-24 shrink-0">
      <option value="1">${t('profile.sparks.priority.p1')}</option>
      <option value="2">${t('profile.sparks.priority.p2')}</option>
      <option value="3" selected>${t('profile.sparks.priority.p3')}</option>
      <option value="4">${t('profile.sparks.priority.p4')}</option>
      <option value="5">${t('profile.sparks.priority.p5')}</option>
    </select>
    ${button({ id: 'btn-add-spark', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
  </div>
`;

const wireOverviewFlat = () => {
  ['ov-name', 'ov-headline', 'ov-summary'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    let last = el.value;
    el.addEventListener('blur', async () => {
      if (el.value === last) return;
      try {
        await updateOverview({ [el.dataset.field]: el.value });
        last = el.value;
      } catch (err) {
        setInlineError('overview-error', err.message || String(err));
      }
    });
  });

  document.getElementById('btn-redo-intro')?.addEventListener('click', async () => {
    await clearOnboarded();
    const overview = await getOverview();
    state.wizardStep = 1;
    state.wizardOverview = {
      name: overview?.name || '',
      headline: overview?.headline || '',
      summary: overview?.summary || '',
      skills: overview?.skills || [],
    };
    state.wizardSparkIds = { 5: [], 6: [], 7: [] };
    renderWizard(document.getElementById('tab-content'));
  });

  wireSparkInput({ inWizard: false });
  wireSparks();

  // Wire the skills editor on the flat form: any change flushes to the DB.
  // Initial skills come from the overview snapshot captured at render time.
  wireSkillsEditor('ov-skills-editor', overview?.skills || [], async (skills) => {
    await updateOverview({ skills });
  });
};

// ---------- skills editor ----------
//
// Pill mode: existing skills render as color-coded pills (color encodes
// level — expert=emerald, advanced=blue, intermediate=amber, beginner=slate,
// unset=slate). Adding a skill uses a single input row (name / years /
// level) that clears on submit. To change a skill, delete the pill and
// re-add it. Same interaction model as sparks.
//
// Used on the flat form and inside the wizard. Renders as HTML;
// wireSkillsEditor attaches handlers and invokes onChange(skills[]) whenever
// the current skill set mutates (add or delete).

const SKILL_LEVEL_COLOR = {
  expert:       'emerald',
  advanced:     'blue',
  intermediate: 'amber',
  beginner:     'slate',
};

const capitalize = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';

const skillPillHtml = (s, i) => {
  const color = SKILL_LEVEL_COLOR[s.level] || 'slate';
  const suffix = [];
  if (s.years != null) suffix.push(`${s.years}y`);
  if (s.level) suffix.push(capitalize(s.level));
  const suffixHtml = suffix.length
    ? ` <span class="opacity-70">· ${escapeHtml(suffix.join(' · '))}</span>`
    : '';
  return removablePill({
    bodyHtml: `${escapeHtml(s.name)}${suffixHtml}`,
    color,
    classes: 'gap-1.5',
    dataset: { 'skill-index': String(i) },
    dismissClass: 'js-remove-skill',
    dismissLabel: `Remove skill ${s.name}`,
  });
};

const skillsEditorHtml = ({ mountId, skills = [] }) => `
  <div id="${mountId}" data-skills-editor class="space-y-3">
    <div class="flex items-center gap-2">
      <input type="text" class="${CLS.inputBase} flex-1 min-w-0 js-skill-name" placeholder="${t('profile.skills.name_placeholder')}" autocomplete="off" />
      <input type="number" class="${CLS.inputBase} w-16 shrink-0 px-2 text-center js-skill-years"
             min="0" step="0.5" placeholder="${t('profile.skills.years_placeholder')}" title="${t('profile.skills.years_title')}" />
      <select class="${CLS.inputBase} w-32 shrink-0 js-skill-level" title="${t('profile.skills.level_title')}">
        <option value="">—</option>
        ${SKILL_LEVELS.map(lvl => `<option value="${lvl}">${capitalize(lvl)}</option>`).join('')}
      </select>
      ${button({ variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add'), extraClass: 'js-add-skill' })}
    </div>
    <div class="js-skill-pills flex flex-wrap gap-2">
      ${skills.length
        ? skills.map((s, i) => skillPillHtml(s, i)).join('')
        : `<p class="text-sm text-slate-400">${t('profile.skills.empty')}</p>`}
    </div>
  </div>
`;

// wireSkillsEditor attaches handlers to a rendered skillsEditorHtml block.
// The mount owns its own "current skills" snapshot via dataset so callers
// don't have to re-render the whole shell on every add/delete.
const wireSkillsEditor = (mountId, initialSkills, onChange) => {
  const mount = document.getElementById(mountId);
  if (!mount) return;

  let skills = [...(initialSkills || [])];

  const rerenderPills = () => {
    const pillsEl = mount.querySelector('.js-skill-pills');
    if (!pillsEl) return;
    pillsEl.innerHTML = skills.length
      ? skills.map((s, i) => skillPillHtml(s, i)).join('')
      : `<p class="text-sm text-slate-400">${t('profile.skills.empty')}</p>`;
    wirePills();
  };

  const wirePills = () => {
    mount.querySelectorAll('.js-remove-skill').forEach(btn => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.skillIndex);
        if (Number.isNaN(idx)) return;
        skills.splice(idx, 1);
        rerenderPills();
        try { await onChange(skills); }
        catch (err) { console.error('[skills editor] delete', err); }
      });
    });
  };

  const nameInput = mount.querySelector('.js-skill-name');
  const yearsInput = mount.querySelector('.js-skill-years');
  const levelSel = mount.querySelector('.js-skill-level');
  const addBtn = mount.querySelector('.js-add-skill');

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const skill = { name };
    if (yearsInput.value !== '') skill.years = Number(yearsInput.value);
    if (levelSel.value) skill.level = levelSel.value;
    skills.push(skill);
    // Clear the input row so the next skill can be typed immediately.
    nameInput.value = '';
    yearsInput.value = '';
    levelSel.value = '';
    rerenderPills();
    try { await onChange(skills); }
    catch (err) { console.error('[skills editor] add', err); }
    nameInput.focus();
  };

  nameInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
  });
  yearsInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
  });
  addBtn?.addEventListener('click', submit);

  wirePills();
};

// Wire the shared "type a spark and press Enter" input. inWizard=true tracks
// each newly-created spark against the current themed step so it only shows
// under that theme.
const wireSparkInput = ({ inWizard }) => {
  const input = document.getElementById('spark-input');
  const priority = document.getElementById('spark-priority');
  const addBtn = document.getElementById('btn-add-spark');
  if (!input || !addBtn) return;

  const submit = async () => {
    const val = input.value.trim();
    if (!val) return;
    const p = priority ? Number(priority.value) : undefined;
    const id = await createSpark(val, p);
    if (inWizard) {
      (state.wizardSparkIds[state.wizardStep] ||= []).push(id);
    }
    input.value = '';
    if (priority) priority.value = '3'; // reset so the next add starts neutral
    await rerenderSparksList();
    input.focus();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
  });
  addBtn.addEventListener('click', submit);
};

// Refresh the sparks-list block using the current view context (wizard step
// subset vs. flat full list). During themed wizard steps that also render an
// "already on file" carryover block, refresh that too so deletes there
// update immediately.
const rerenderSparksList = async () => {
  const listEl = document.getElementById('sparks-list');
  if (!listEl) return;
  const inThemedStep = state.wizardStep >= 5 && state.wizardStep <= 7;
  const stepIds = inThemedStep ? state.wizardSparkIds[state.wizardStep] : null;
  const all = await listSparks();
  const shown = stepIds ? all.filter(s => stepIds.includes(s.id)) : all;
  listEl.innerHTML = sparksListHtml(shown);

  const carryoverEl = document.getElementById('carryover-sparks');
  if (carryoverEl && inThemedStep) {
    const tracked = new Set([
      ...(state.wizardSparkIds[5] || []),
      ...(state.wizardSparkIds[6] || []),
      ...(state.wizardSparkIds[7] || []),
    ]);
    carryoverEl.innerHTML = sparksListHtml(all.filter(s => !tracked.has(s.id)));
  }

  wireSparks();
};

const wireSparks = () => {
  const listEl = document.getElementById('sparks-list');
  if (!listEl) return;

  listEl.querySelectorAll('.js-spark-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.sparkId);
      await deleteSpark(id);
      if (state.wizardStep >= 5 && state.wizardStep <= 7) {
        const arr = state.wizardSparkIds[state.wizardStep] || [];
        const idx = arr.indexOf(id);
        if (idx >= 0) arr.splice(idx, 1);
      }
      await rerenderSparksList();
    });
  });

};

// ---------- wizard ----------

const WIZARD_STEPS = 8;

// Themed spark steps sit between the text prompts (1–4) and the recap (8).
// Keys must match the step numbers so `SPARK_THEMES[step]` works directly.
const sparkThemes = () => ({
  5: {
    title: t('profile.wizard.spark.env.title'),
    prompt: t('profile.wizard.spark.env.prompt'),
    hints: t('profile.wizard.spark.env.hint'),
    chips: ['remote-friendly', 'async-first', 'small team (<15)', 'hybrid ok'],
  },
  6: {
    title: t('profile.wizard.spark.values.title'),
    prompt: t('profile.wizard.spark.values.prompt'),
    hints: t('profile.wizard.spark.values.hint'),
    chips: ['high-agency', 'ships weekly', 'mission-driven', 'mentorship available'],
  },
  7: {
    title: t('profile.wizard.spark.craft.title'),
    prompt: t('profile.wizard.spark.craft.prompt'),
    hints: t('profile.wizard.spark.craft.hint'),
    chips: ['Go', 'TypeScript', 'data pipelines', 'no on-call'],
  },
});

const renderWizard = async (el) => {
  const step = state.wizardStep;
  const dots = Array.from({ length: WIZARD_STEPS }, (_, i) =>
    `<span class="inline-block h-2 w-2 rounded-full ${i < step ? 'bg-blue-600' : 'bg-slate-200'}"></span>`,
  ).join(' ');

  let body = '';
  if (step === 1) body = wizardTextStep({ label: t('profile.wizard.name.label'), hint: t('profile.field.name.hint'), field: 'name', placeholder: t('profile.field.name.placeholder'), multiline: false });
  else if (step === 2) body = wizardTextStep({ label: t('profile.wizard.headline.label'), hint: t('profile.field.headline.hint'), field: 'headline', placeholder: t('profile.field.headline.placeholder'), multiline: false, examples: [
    t('profile.wizard.headline.example1'),
    t('profile.wizard.headline.example2'),
    t('profile.wizard.headline.example3'),
    t('profile.wizard.headline.example4'),
    t('profile.wizard.headline.example5'),
  ] });
  else if (step === 3) body = wizardTextStep({ label: t('profile.wizard.summary.label'), hint: t('profile.field.summary.hint'), field: 'summary', placeholder: t('profile.wizard.summary.placeholder'), multiline: true });
  else if (step === 4) body = wizardSkillsStep();
  else if (step >= 5 && step <= 7) body = await wizardSparkStep(sparkThemes()[step]);
  else if (step === 8) body = await wizardRecapStep();

  el.innerHTML = `
    <div class="${CLS.card} max-w-2xl mx-auto">
      <div class="flex items-center justify-between">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">${t('profile.wizard.progress', { step, total: WIZARD_STEPS })}</p>
        <div class="flex gap-1.5" aria-hidden="true">${dots}</div>
      </div>
      ${inlineError({ id: 'wizard-error' })}
      <div class="pt-2">${body}</div>
      <div class="flex items-center justify-between pt-4">
        <div>
          ${step > 1 ? button({ id: 'btn-wizard-back', variant: 'secondaryCompact', label: t('profile.wizard.action.back') }) : ''}
        </div>
        <div class="flex gap-2">
          ${step <= 4 ? button({ id: 'btn-wizard-skip', variant: 'linkMuted', label: t('profile.wizard.action.skip_all') }) : ''}
          ${step < WIZARD_STEPS
            ? button({ id: 'btn-wizard-next', variant: 'primaryCompact', label: t('profile.wizard.action.next') })
            : button({ id: 'btn-wizard-done', variant: 'primaryCompact', icon: 'check', label: t('profile.wizard.action.finish') })}
        </div>
      </div>
    </div>
  `;
  wireWizard(el);
};

const wizardSkillsStep = () => `
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-slate-900">${t('profile.wizard.skills.heading')}</h2>
      <p class="mt-1 text-sm text-slate-500">${t('profile.wizard.skills.help')}</p>
    </div>
    ${skillsEditorHtml({ mountId: 'wiz-skills-editor', skills: state.wizardOverview.skills || [] })}
  </div>
`;

const wizardTextStep = ({ label, hint, field, placeholder, multiline, examples }) => {
  const val = state.wizardOverview[field] || '';
  const control = multiline
    ? `<textarea id="wiz-input" rows="6" placeholder="${escapeHtml(placeholder)}" class="${CLS.textarea}">${escapeHtml(val)}</textarea>`
    : `<input id="wiz-input" type="text" value="${escapeHtml(val)}" placeholder="${escapeHtml(placeholder)}" class="${CLS.input}" />`;
  const ex = examples?.length
    ? `<ul class="mt-3 space-y-1 text-xs text-slate-500">${examples.map(e => `<li>· ${escapeHtml(e)}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="space-y-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">${escapeHtml(label)}</h2>
        <p class="mt-1 text-sm text-slate-500">${escapeHtml(hint)}</p>
      </div>
      ${control}
      ${ex}
    </div>
  `;
};

const wizardSparkStep = async (theme) => {
  const stepSparks = await sparksForCurrentWizardStep();
  const carryover = await carryoverSparks();
  return `
    <div class="space-y-4">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">${escapeHtml(theme.title)}</h2>
        <p class="mt-1 text-sm text-slate-700">${escapeHtml(theme.prompt)}</p>
        <p class="mt-1 text-xs text-slate-500">${escapeHtml(theme.hints)}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        ${theme.chips.map(c => chip({ label: c, dataset: { chip: c } })).join('')}
      </div>
      <div id="sparks-list" class="space-y-2">${sparksListHtml(stepSparks)}</div>
      ${sparkInputHtml()}
      ${carryover.length ? `
        <div class="space-y-2 border-t border-slate-100 pt-4">
          <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">${t('profile.wizard.spark.already_on_file')}</p>
          <p class="text-xs text-slate-500">${t('profile.wizard.spark.already_on_file_help')}</p>
          <div id="carryover-sparks" class="opacity-75">${sparksListHtml(carryover)}</div>
        </div>
      ` : ''}
    </div>
  `;
};

// Only the sparks the user added during the current themed step. Keeps each
// step visually focused instead of accumulating a growing list across steps.
const sparksForCurrentWizardStep = async () => {
  const ids = new Set(state.wizardSparkIds[state.wizardStep] || []);
  if (!ids.size) return [];
  const all = await listSparks();
  return all.filter(s => ids.has(s.id));
};

// Sparks that predate this wizard session — anything not tracked in any of
// the themed-step buckets. Surfaced as an "already on file" section on the
// themed spark steps so a user who hit "Redo intro" doesn't feel like their
// prior sparks vanished.
const carryoverSparks = async () => {
  const tracked = new Set([
    ...(state.wizardSparkIds[5] || []),
    ...(state.wizardSparkIds[6] || []),
    ...(state.wizardSparkIds[7] || []),
  ]);
  const all = await listSparks();
  return all.filter(s => !tracked.has(s.id));
};

const wizardRecapStep = async () => {
  const [ov, sparks] = await Promise.all([getOverview(), listSparks()]);
  const line = (label, val) => `
    <div class="grid gap-1">
      <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">${escapeHtml(label)}</p>
      <p class="text-sm text-slate-900">${val ? escapeHtml(val) : `<span class="text-slate-400">${t('common.status.not_set')}</span>`}</p>
    </div>
  `;
  const formatSkill = (s) => {
    const bits = [];
    if (s.years != null) bits.push(`${s.years}y`);
    if (s.level) bits.push(`${s.level[0].toUpperCase()}${s.level.slice(1)}`);
    return bits.length ? `${escapeHtml(s.name)} (${bits.join(' · ')})` : escapeHtml(s.name);
  };
  const skillsList = (ov?.skills || []).length
    ? `<ul class="mt-1 space-y-1 text-sm text-slate-900">${ov.skills.map(s => `<li>· ${formatSkill(s)}</li>`).join('')}</ul>`
    : `<p class="text-sm text-slate-400">${t('common.status.none')}</p>`;
  const sparkList = sparks.length
    ? `<ul class="mt-1 space-y-1 text-sm text-slate-900">${sparks.map(s => `<li>· ${escapeHtml(s.body)}</li>`).join('')}</ul>`
    : `<p class="text-sm text-slate-400">${t('common.status.none')}</p>`;
  return `
    <div class="space-y-4">
      <h2 class="text-lg font-semibold text-slate-900">${t('profile.recap.heading')}</h2>
      ${line(t('profile.recap.name'), ov?.name)}
      ${line(t('profile.recap.headline'), ov?.headline)}
      ${line(t('profile.recap.summary'), ov?.summary)}
      <div class="grid gap-1">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">${t('profile.recap.skills')}</p>
        ${skillsList}
      </div>
      <div class="grid gap-1">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">${t('profile.recap.sparks')}</p>
        ${sparkList}
      </div>
    </div>
  `;
};

const wireWizard = (el) => {
  const step = state.wizardStep;
  const input = document.getElementById('wiz-input');
  if (input) input.focus();

  document.getElementById('btn-wizard-back')?.addEventListener('click', () => {
    state.wizardStep = Math.max(1, step - 1);
    renderWizard(el);
  });

  document.getElementById('btn-wizard-skip')?.addEventListener('click', async () => {
    await persistWizardTextIfAny();
    await markOnboarded();
    renderOverviewTab(el);
  });

  document.getElementById('btn-wizard-next')?.addEventListener('click', async () => {
    try {
      await persistWizardTextIfAny();
      state.wizardStep = step + 1;
      renderWizard(el);
    } catch (err) {
      setInlineError('wizard-error', err.message || String(err));
    }
  });

  document.getElementById('btn-wizard-done')?.addEventListener('click', async () => {
    await markOnboarded();
    renderOverviewTab(el);
  });

  // Wizard: chip clicks and the shared input feed the same createSpark path,
  // tagged against the current themed step so only this step's contributions
  // are shown.
  document.querySelectorAll('.js-chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = await createSpark(btn.dataset.chip);
      (state.wizardSparkIds[state.wizardStep] ||= []).push(id);
      await rerenderSparksList();
    });
  });
  wireSparkInput({ inWizard: true });
  wireSparks();

  // Step 4 has the skills editor. Persist to DB on any change and mirror
  // into state.wizardOverview so the recap step + Back navigation see it.
  wireSkillsEditor('wiz-skills-editor', state.wizardOverview.skills || [], async (skills) => {
    state.wizardOverview.skills = skills;
    await updateOverview({ skills });
  });
};

const persistWizardTextIfAny = async () => {
  const input = document.getElementById('wiz-input');
  if (!input) return;
  const step = state.wizardStep;
  const field = step === 1 ? 'name'
              : step === 2 ? 'headline'
              : step === 3 ? 'summary'
              : null;
  if (!field) return;
  state.wizardOverview[field] = input.value;
  await updateOverview({ [field]: input.value });
};

// ============================================================================
// RESUMES TAB
// ============================================================================

const renderResumesTab = async (el) => {
  el.innerHTML = `<p class="text-sm text-slate-500">${t('app.loading')}</p>`;
  refreshProfileTabCounts();
  const resumes = await listResumes();
  el.innerHTML = `
    <div class="space-y-6">
      <section class="flex items-center justify-between">
        <p class="text-sm text-slate-500">${t('profile.resumes.help')}</p>
        ${button({ id: 'btn-new-resume', variant: 'primaryCompact', icon: 'plus', label: t('profile.resumes.action.new'), ariaLabel: t('profile.resumes.aria.add') })}
      </section>
      <section id="resume-editor" class="${state.resumeEditorId || state.resumeEditorNew ? '' : 'hidden'}"></section>
      <section id="resume-list" class="${CLS.card}">
        ${resumes.length ? resumesListHtml(resumes) : emptyState({ message: t('profile.resumes.empty') })}
      </section>
    </div>
  `;
  document.getElementById('btn-new-resume').addEventListener('click', () => openResumeEditor(null));
  wireResumesList();
  if (state.resumeEditorId || state.resumeEditorNew) {
    await mountResumeEditor();
  }
};

const resumesListHtml = (resumes) => `
  <ul class="space-y-3">
    ${resumes.map(r => `
      <li class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-slate-900">${escapeHtml(r.title || t('profile.resumes.untitled'))}</span>
              ${badge({ label: r.format === 'typ' ? t('profile.resumes.format.typst') : t('profile.resumes.format.markdown'), color: r.format === 'typ' ? 'violet' : 'slate', size: 'xs' })}
              ${r.is_primary ? badge({ label: t('profile.resumes.primary'), color: 'emerald', size: 'xs' }) : ''}
            </div>
            <p class="text-xs text-slate-500">${t('common.updated_at', { date: formatDate(r.updated_at) })}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${r.is_primary
              ? ''
              : button({ variant: 'secondaryCompact', label: t('profile.resumes.action.set_primary'), extraClass: 'js-primary', dataset: { id: r.id } })}
            ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: t('common.action.edit'), extraClass: 'js-edit-resume', dataset: { id: r.id } })}
            ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('common.action.delete'), extraClass: 'js-delete-resume', dataset: { id: r.id, title: r.title || t('profile.resumes.untitled') } })}
          </div>
        </div>
      </li>
    `).join('')}
  </ul>
`;

const wireResumesList = () => {
  document.querySelectorAll('.js-edit-resume').forEach(b => b.addEventListener('click', () => openResumeEditor(Number(b.dataset.id))));
  document.querySelectorAll('.js-delete-resume').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(t('profile.resumes.confirm.delete', { title: b.dataset.title }))) return;
    await deleteResume(Number(b.dataset.id));
    if (state.resumeEditorId === Number(b.dataset.id)) closeResumeEditor();
    toast(t('profile.resumes.toast.deleted'), 'ok');
    renderResumesTab(document.getElementById('tab-content'));
  }));
  document.querySelectorAll('.js-primary').forEach(b => b.addEventListener('click', async () => {
    await setPrimaryResume(Number(b.dataset.id));
    renderResumesTab(document.getElementById('tab-content'));
  }));
};

const openResumeEditor = (id) => {
  state.resumeEditorId = id;
  state.resumeEditorNew = id == null;
  renderResumesTab(document.getElementById('tab-content'));
};

const closeResumeEditor = () => {
  state.resumeEditorId = null;
  state.resumeEditorNew = false;
  if (state.resumePdfUrl) { URL.revokeObjectURL(state.resumePdfUrl); state.resumePdfUrl = null; }
  state.resumePdfBlob = null;
};

const mountResumeEditor = async () => {
  const editorEl = document.getElementById('resume-editor');
  const resume = state.resumeEditorId ? await getResume(state.resumeEditorId) : null;
  const isNew = !resume;
  const r = resume || { title: '', format: 'md', body: '' };
  const pdfList = resume ? await listPdfsForResume(resume.id) : [];

  editorEl.innerHTML = `
    <div class="${CLS.card}">
      <form id="resume-form" class="space-y-4">
        <div class="flex items-baseline justify-between">
          <p class="${CLS.eyebrow}">${isNew ? t('profile.resumes.form.new_eyebrow') : t('profile.resumes.form.edit_eyebrow')}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('common.action.save') })}
            ${button({ id: 'btn-close-resume', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.cancel') })}
          </div>
        </div>
        ${inlineError({ id: 'resume-error' })}
        <div class="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          ${formField({ type: 'text', name: 'res-title', label: t('profile.resumes.field.title.label'),
                        value: r.title, required: true,
                        placeholder: t('profile.resumes.field.title.placeholder') })}
          ${formField({ type: 'select', name: 'res-format', label: t('profile.resumes.field.format.label'),
                        options: [
                          { value: 'md',  label: t('profile.resumes.field.format.markdown'), selected: r.format === 'md' },
                          { value: 'typ', label: t('profile.resumes.field.format.typst'),   selected: r.format === 'typ' },
                        ] })}
        </div>
        ${formField({ type: 'textarea', name: 'res-body', label: t('profile.resumes.field.source.label'),
                      value: r.body, rows: 25, extraClass: 'font-mono text-xs',
                      placeholder: t('profile.resumes.field.source.placeholder') })}
      </form>

      <div id="typst-panel" class="${r.format === 'typ' ? '' : 'hidden'} space-y-3 border-t border-slate-200 pt-4">
        ${inlineError({ id: 'compile-error' })}
        <div class="flex items-center gap-2">
          ${button({ id: 'btn-compile', variant: 'secondaryCompact', icon: 'sparkles', label: t('profile.resumes.action.compile') })}
          <span id="compile-status" class="text-xs text-slate-500"></span>
        </div>
        <div id="pdf-preview" class="hidden">
          <iframe id="pdf-iframe" class="h-96 w-full rounded-xl border border-slate-200" title="${t('profile.resumes.pdf_preview_title')}"></iframe>
          <div class="mt-2 flex items-center gap-2">
            ${button({ id: 'btn-attach-pdf', variant: 'primaryCompact', icon: 'arrowUpTray', label: t('profile.resumes.action.attach') })}
            ${button({ id: 'btn-download-pdf', variant: 'secondaryCompact', icon: 'arrowDownTray', label: t('profile.resumes.action.download') })}
          </div>
        </div>
        <div id="compile-log" class="hidden max-h-40 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] text-slate-700"></div>
      </div>

      <div class="border-t border-slate-200 pt-4">
        <p class="${CLS.eyebrow}">${t('profile.resumes.sent.eyebrow')}</p>
        <div id="sent-pdfs" class="mt-3">${sentPdfsHtml(pdfList)}</div>
      </div>
    </div>
  `;

  wireResumeEditor();
};

const sentPdfsHtml = (rows) => {
  if (!rows.length) return `<p class="text-xs text-slate-500">${t('profile.resumes.sent.empty')}</p>`;
  return `<ul class="space-y-2">${rows.map(r => `
    <li class="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
      <div class="min-w-0">
        <p class="truncate font-medium text-slate-900">${escapeHtml(r.original_filename || r.filename)}</p>
        <p class="text-xs text-slate-500">${r.application_role_title
          ? (r.application_company_name
              ? t('profile.resumes.sent.item_with_company', { role: escapeHtml(r.application_role_title), company: escapeHtml(r.application_company_name) })
              : t('profile.resumes.sent.item', { role: escapeHtml(r.application_role_title) }))
          : t('profile.resumes.sent.deleted')} · ${formatDate(r.created_at)}${r.size_bytes ? ' · ' + formatBytes(r.size_bytes) : ''}</p>
      </div>
    </li>
  `).join('')}</ul>`;
};

const wireResumeEditor = () => {
  const form = document.getElementById('resume-form');
  const formatSel = document.getElementById('res-format');
  const typstPanel = document.getElementById('typst-panel');
  formatSel.addEventListener('change', () => {
    typstPanel.classList.toggle('hidden', formatSel.value !== 'typ');
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = {
      title: document.getElementById('res-title').value,
      format: formatSel.value,
      body: document.getElementById('res-body').value,
    };
    if (!data.title.trim()) {
      setInlineError('resume-error', t('profile.resumes.error.title_required'));
      return;
    }
    try {
      if (state.resumeEditorId) {
        await updateResume(state.resumeEditorId, data);
        toast(t('profile.resumes.toast.saved'), 'ok');
      } else {
        const id = await createResume(data);
        state.resumeEditorId = id;
        state.resumeEditorNew = false;
        toast(t('profile.resumes.toast.created', { id }), 'ok');
      }
      renderResumesTab(document.getElementById('tab-content'));
    } catch (err) {
      setInlineError('resume-error', err.message || String(err));
    }
  });

  document.getElementById('btn-close-resume')?.addEventListener('click', () => {
    closeResumeEditor();
    renderResumesTab(document.getElementById('tab-content'));
  });

  document.getElementById('btn-compile')?.addEventListener('click', () => compileCurrentResume());
  document.getElementById('btn-attach-pdf')?.addEventListener('click', () => openAttachDialog());
  document.getElementById('btn-download-pdf')?.addEventListener('click', () => downloadCurrentPdf());
};

const compileCurrentResume = async () => {
  const status = document.getElementById('compile-status');
  const preview = document.getElementById('pdf-preview');
  const iframe = document.getElementById('pdf-iframe');
  const logEl = document.getElementById('compile-log');
  const source = document.getElementById('res-body').value;
  setInlineError('compile-error', '');
  if (!source.trim()) { setInlineError('compile-error', t('profile.resumes.compile.empty')); return; }
  status.textContent = t('profile.resumes.compile.running');
  preview.classList.add('hidden');
  logEl.classList.add('hidden');
  try {
    const { pdf, log } = await compileTypstToPdf(source);
    if (state.resumePdfUrl) URL.revokeObjectURL(state.resumePdfUrl);
    state.resumePdfBlob = new Blob([pdf], { type: 'application/pdf' });
    state.resumePdfUrl = URL.createObjectURL(state.resumePdfBlob);
    iframe.src = state.resumePdfUrl;
    preview.classList.remove('hidden');
    status.textContent = t('profile.resumes.compile.done', { size: formatBytes(state.resumePdfBlob.size) });
    if (log) {
      logEl.textContent = log;
      logEl.classList.remove('hidden');
    }
  } catch (err) {
    status.textContent = '';
    const friendly = err.code === 'not_typst_source'
      ? t('profile.resumes.compile.not_typst_source')
      : (err.message || String(err));
    setInlineError('compile-error', t('profile.resumes.compile.failed', { err: friendly }));
    if (err.log) {
      logEl.textContent = err.log;
      logEl.classList.remove('hidden');
    }
  }
};

const downloadCurrentPdf = () => {
  if (!state.resumePdfBlob) return;
  const a = document.createElement('a');
  a.href = state.resumePdfUrl;
  a.download = `${(document.getElementById('res-title').value || 'resume').replace(/[^\w-]+/g, '_')}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// ---------- attach-to-application dialog ----------

const openAttachDialog = async () => {
  if (!state.resumePdfBlob || !state.resumeEditorId) {
    setInlineError('resume-error', t('profile.resumes.attach.compile_first'));
    return;
  }
  const [apps, companies] = await Promise.all([listApplications(), listCompanies()]);
  if (!apps.length) {
    setInlineError('resume-error', t('profile.resumes.attach.no_applications'));
    return;
  }
  const companyById = new Map(companies.map(c => [c.id, c]));
  const dlg = document.createElement('div');
  dlg.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4';
  dlg.innerHTML = `
    <div class="${CLS.card} w-full max-w-md">
      <p class="${CLS.eyebrow}">${t('profile.resumes.attach.dialog_eyebrow')}</p>
      ${inlineError({ id: 'attach-error' })}
      <div class="grid gap-2">
        <label class="${CLS.label}" for="attach-app">${t('profile.resumes.attach.application_label')}</label>
        <select id="attach-app" class="${CLS.select}">
          ${apps.map(a => {
            const co = companyById.get(a.company_id);
            const label = `${a.role_title || '(no title)'} — ${co?.official_name || 'unknown'}`;
            return `<option value="${a.id}" data-company="${escapeHtml(co?.official_name || '')}">${escapeHtml(label)}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        ${button({ id: 'btn-confirm-attach', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('profile.resumes.attach.attach') })}
        ${button({ id: 'btn-cancel-attach', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.cancel') })}
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('#btn-cancel-attach').addEventListener('click', close);
  dlg.querySelector('#btn-confirm-attach').addEventListener('click', async () => {
    const sel = dlg.querySelector('#attach-app');
    const applicationId = Number(sel.value);
    const companyName = sel.selectedOptions[0]?.dataset.company || '';
    try {
      const title = document.getElementById('res-title').value || 'resume';
      const filename = `${title.replace(/[^\w-]+/g, '_')}.pdf`;
      const file = new File([state.resumePdfBlob], filename, { type: 'application/pdf' });
      const folder = sanitizeFolder(companyName);
      const meta = await uploadAttachment(folder, file);
      await linkPdfToApplication({
        resumeId: state.resumeEditorId,
        applicationId,
        folder: meta.folder,
        storedFilename: meta.storedFilename,
        originalFilename: meta.originalFilename,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
        sha256: meta.sha256,
      });
      close();
      toast(t('profile.resumes.toast.attached', { name: meta.storedFilename }), 'ok');
      await mountResumeEditor();
    } catch (err) {
      const msg = err.code === 'no_storage_backend' ? t('common.error.no_storage_backend') : (err.message || String(err));
      setInlineError('attach-error', msg);
    }
  });
};

// ============================================================================
// BRAG SHEET TAB
// ============================================================================

const renderBragTab = async (el) => {
  el.innerHTML = `<p class="text-sm text-slate-500">${t('app.loading')}</p>`;
  refreshProfileTabCounts();
  const [entries, companies] = await Promise.all([listBragEntries(), listCompanies()]);
  el.innerHTML = `
    <div class="space-y-6">
      <section class="flex items-center justify-between">
        <p class="text-sm text-slate-500">${t('profile.brags.help')}</p>
        ${button({ id: 'btn-new-brag', variant: 'primaryCompact', icon: 'plus', label: t('profile.brags.action.new'), ariaLabel: t('profile.brags.aria.add') })}
      </section>
      <section id="brag-editor" class="${state.bragEditorId || state.bragEditorNew ? '' : 'hidden'}"></section>
      <section id="brag-list" class="${CLS.card}">
        ${entries.length ? bragListHtml(entries) : emptyState({ message: t('profile.brags.empty') })}
      </section>
    </div>
  `;
  document.getElementById('btn-new-brag').addEventListener('click', () => openBragEditor(null));
  wireBragList();
  if (state.bragEditorId || state.bragEditorNew) {
    await mountBragEditor(companies);
  }
};

const bragListHtml = (entries) => `
  <ul class="space-y-3">
    ${entries.map(e => `
      <li class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="font-semibold text-slate-900">${escapeHtml(e.title || t('profile.brags.untitled'))}</p>
              ${e.entry_date ? badge({ label: String(e.entry_date).slice(0, 4), color: 'violet', size: 'xs' }) : ''}
            </div>
            <p class="line-clamp-1 text-sm text-slate-700">${escapeHtml(e.body)}</p>
            ${e.impact ? `<p class="line-clamp-1 text-sm font-medium text-emerald-700">${t('profile.brags.impact', { text: escapeHtml(e.impact) })}</p>` : ''}
            <div class="flex flex-wrap items-center gap-2 pt-1">
              ${e.company_name ? badge({ label: e.company_name, color: 'blue', size: 'xs' }) : ''}
              ${(e.tags || []).map(tag => badge({ label: tag, color: 'slate', size: 'xs' })).join('')}
            </div>
            ${e.tags_generated_at ? `<p class="text-xs text-slate-500">${t('profile.brags.tags_updated', { date: formatDate(e.tags_generated_at) })}</p>` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: t('common.action.edit'), extraClass: 'js-edit-brag', dataset: { id: e.id } })}
            ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('common.action.delete'), extraClass: 'js-delete-brag', dataset: { id: e.id, title: e.title || t('profile.brags.untitled') } })}
          </div>
        </div>
      </li>
    `).join('')}
  </ul>
`;

const wireBragList = () => {
  document.querySelectorAll('.js-edit-brag').forEach(b => b.addEventListener('click', () => openBragEditor(Number(b.dataset.id))));
  document.querySelectorAll('.js-delete-brag').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(t('profile.brags.confirm.delete', { title: b.dataset.title }))) return;
    await deleteBragEntry(Number(b.dataset.id));
    if (state.bragEditorId === Number(b.dataset.id)) closeBragEditor();
    toast(t('profile.brags.toast.deleted'), 'ok');
    renderBragTab(document.getElementById('tab-content'));
  }));
};

const openBragEditor = (id) => {
  state.bragEditorId = id;
  state.bragEditorNew = id == null;
  state.bragDraftTags = [];
  state.bragPendingTagsGeneratedAt = null;
  renderBragTab(document.getElementById('tab-content'));
};

const closeBragEditor = () => {
  state.bragEditorId = null;
  state.bragEditorNew = false;
  state.bragDraftTags = [];
  state.bragPendingTagsGeneratedAt = null;
};

const mountBragEditor = async (companies) => {
  const editorEl = document.getElementById('brag-editor');
  const entry = state.bragEditorId ? await (await import('../entities/brag-entries.mjs')).getBragEntry(state.bragEditorId) : null;
  const isNew = !entry;
  const e = entry || { title: '', body: '', impact: '', tags: [], tags_generated_at: null, company_id: null, entry_date: null };
  if (!state.bragDraftTags.length) state.bragDraftTags = [...(e.tags || [])];
  editorEl.innerHTML = `
    <div class="${CLS.card}">
      <form id="brag-form" class="space-y-4">
        <div class="flex items-baseline justify-between">
          <p class="${CLS.eyebrow}">${isNew ? t('profile.brags.form.new_eyebrow') : t('profile.brags.form.edit_eyebrow')}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t('common.action.save') })}
            ${button({ id: 'btn-close-brag', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.cancel') })}
          </div>
        </div>
        ${inlineError({ id: 'brag-error' })}
        ${formField({ type: 'text', name: 'brag-title', label: t('profile.brags.field.title.label'),
                      value: e.title, required: true,
                      placeholder: t('profile.brags.field.title.placeholder') })}
        ${formField({ type: 'textarea', name: 'brag-body', label: t('profile.brags.field.description.label'),
                      value: e.body, rows: 6,
                      placeholder: t('profile.brags.field.description.placeholder') })}
        ${formField({ type: 'text', name: 'brag-impact', label: t('profile.brags.field.impact.label'),
                      value: e.impact || '',
                      placeholder: t('profile.brags.field.impact.placeholder') })}
        <div class="grid gap-4 sm:grid-cols-2">
          ${formField({ type: 'select', name: 'brag-company', label: t('profile.brags.field.company.label'),
                        options: [
                          { value: '', label: t('common.status.none'), selected: !e.company_id },
                          ...companies.map(c => ({
                            value: String(c.id),
                            label: c.official_name,
                            selected: c.id === e.company_id,
                          })),
                        ] })}
          ${formField({ type: 'number', name: 'brag-date', label: t('profile.brags.field.year.label'),
                        value: (e.entry_date || '').slice(0, 4),
                        placeholder: CURRENT_YEAR,
                        min: '1970',
                        step: '1' })}
        </div>
        <div class="grid gap-2">
          <div class="flex items-baseline justify-between gap-3">
            <label class="${CLS.label}" for="brag-tag-input">${t('profile.brags.tags.label')}</label>
            ${button({ id: 'btn-generate-brag-tags', variant: 'secondaryCompact', icon: 'sparkles', label: t('profile.brags.tags.generate') })}
          </div>
          ${inlineError({ id: 'brag-tags-error' })}
          <div id="brag-tags-list"></div>
          <div class="flex items-center gap-2">
            <input id="brag-tag-input" type="text" placeholder="${t('profile.brags.tags.placeholder')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
            ${button({ id: 'btn-add-brag-tag', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
          </div>
          <p id="brag-tags-updated" class="text-xs text-slate-500 hidden"></p>
        </div>
      </form>
    </div>
  `;
  const form = document.getElementById('brag-form');
  const normalizeTag = (tag) => String(tag || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const renderTagList = () => {
    const listEl = document.getElementById('brag-tags-list');
    listEl.innerHTML = state.bragDraftTags.length
      ? `<div class="flex flex-wrap gap-2">${state.bragDraftTags.map(bragTagPillHtml).join('')}</div>`
      : `<p class="text-sm text-slate-400">${t('profile.brags.tags.empty')}</p>`;
    listEl.querySelectorAll('.js-brag-tag-delete').forEach(btn => btn.addEventListener('click', () => {
      const tag = normalizeTag(btn.dataset.tag);
      state.bragDraftTags = state.bragDraftTags.filter(t => normalizeTag(t) !== tag);
      renderTagList();
    }));
    const stamp = state.bragPendingTagsGeneratedAt || e.tags_generated_at;
    const stampEl = document.getElementById('brag-tags-updated');
    stampEl.textContent = stamp ? t('profile.brags.tags_updated', { date: formatDate(stamp) }) : '';
    stampEl.classList.toggle('hidden', !stamp);
  };
  const addTag = () => {
    const input = document.getElementById('brag-tag-input');
    const tag = normalizeTag(input.value);
    if (!tag) return;
    if (!state.bragDraftTags.some(t => normalizeTag(t) === tag)) state.bragDraftTags.push(tag);
    input.value = '';
    renderTagList();
  };
  document.getElementById('btn-add-brag-tag').addEventListener('click', addTag);
  document.getElementById('brag-tag-input').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    addTag();
  });
  document.getElementById('btn-generate-brag-tags').addEventListener('click', async () => {
    try {
      setInlineError('brag-tags-error', '');
      const body = document.getElementById('brag-body').value;
      if (!body.trim()) {
        setInlineError('brag-tags-error', t('profile.brags.error.description_required'));
        return;
      }
      const out = await generateBragTags({ body }, '');
      state.bragDraftTags = Array.isArray(out?.tags) ? out.tags : [];
      state.bragPendingTagsGeneratedAt = new Date().toISOString();
      renderTagList();
    } catch (err) {
      setInlineError('brag-tags-error', err.message || String(err));
    }
  });
  renderTagList();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = document.getElementById('brag-title').value.trim();
    if (!title) { setInlineError('brag-error', t('profile.brags.error.title_required')); return; }
    const data = {
      title,
      body: document.getElementById('brag-body').value,
      impact: document.getElementById('brag-impact').value,
      company_id: document.getElementById('brag-company').value || null,
      entry_date: (() => {
        const raw = document.getElementById('brag-date').value.trim();
        return /^\d{4}$/.test(raw) ? `${raw}-01-01` : null;
      })(),
      tags: state.bragDraftTags,
      tags_generated_at: state.bragPendingTagsGeneratedAt || e.tags_generated_at || null,
    };
    try {
      if (state.bragEditorId) {
        await updateBragEntry(state.bragEditorId, data);
        toast(t('profile.brags.toast.saved'), 'ok');
      } else {
        const id = await createBragEntry(data);
        toast(t('profile.brags.toast.created', { id }), 'ok');
      }
      closeBragEditor();
      renderBragTab(document.getElementById('tab-content'));
    } catch (err) {
      setInlineError('brag-error', err.message || String(err));
    }
  });
  document.getElementById('btn-close-brag').addEventListener('click', () => {
    closeBragEditor();
    renderBragTab(document.getElementById('tab-content'));
  });
};

// ============================================================================
// mount
// ============================================================================

export const mountProfile = async (appEl) => {
  // Optional deep-link: /local/profile?tab=resumes
  const params = new URLSearchParams(window.location.search);
  const initialTab = params.get('tab');
  if (initialTab && TAB_NAMES.includes(initialTab)) state.tab = initialTab;

  appEl.innerHTML = shellHtml();
  wireTabStrip();
  refreshProfileTabCounts();
  renderTab();
};
