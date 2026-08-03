// Career profile page — Overview, Resumes, Brag Sheet. On first run
// (onboarded_at NULL + all fields empty) the Overview tab hosts the 7-step
// setup wizard (see profile_wizard.mjs) instead of the flat form.

import { CLS } from '../ui/classes.mjs';
import { escapeHtml, formatDate, formatBytes } from '../ui/dom.mjs';
import { button, pageHeader, formField, emptyState, helpText, inlineError, setInlineError, badge, logPanel, tab, removablePill } from '../ui/components.mjs';
import { toast } from '../ui/toast.mjs';
import { t } from '../i18n.mjs';
import {
  getOverview, updateOverview, clearOnboarded, SKILL_LEVELS,
  getWizardProgress, clearWizardProgress,
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
import { createProgress } from '../ui/progress.mjs';
import { uploadAttachment, sanitizeFolder } from '../storage/attachments.mjs';
import { compileTypstToPdf } from '../workers/typst-client.mjs';
import { renderWizard as renderWizardModule } from './profile_wizard.mjs';

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
  wizardOverview: { name: '', pitch: '', direction: '', environment: '', skills: [], tools: [] },
  // Sparks the user picked in the values step (4). Tracked so Back to step 4
  // can restore selection state without re-fetching by body text.
  wizardValuesSparkIds: [],
  // Custom "add your own" values captured on step 4 so re-entering the step
  // keeps them selected even before Next commits.
  wizardValuesCustom: [],
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
    <section class="${CLS.pageHeadRow}">
      ${pageHeader({ page: 'profile', title: t('page.profile.title'), tagline: t('profile.tagline') })}
    </section>

    <div class="${CLS.hairline}">
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
  el.innerHTML = `${helpText(t('app.loading'))}`;
  const [overview, sparkCount, progress] = await Promise.all([getOverview(), countSparks(), getWizardProgress()]);
  // Wizard shows until the user hits Finish (onboarded_at set). Resume via
  // wizard_progress covers the mid-flow reload; the empty-fields check covers
  // a truly fresh DB where the user hasn't touched anything yet.
  const inFlight = progress != null;
  const untouched =
    !(overview?.name || '').trim() &&
    !(overview?.headline || '').trim() &&
    !(overview?.summary || '').trim() &&
    !(overview?.environment || '').trim() &&
    !(overview?.tools || []).length &&
    sparkCount === 0;
  const isFirstRun = !overview?.onboarded_at && (inFlight || untouched);
  if (isFirstRun) {
    await seedWizardStateFrom(overview);
    renderWizard(el);
  } else {
    renderOverviewFlat(el, overview);
  }
};

const seedWizardStateFrom = async (overview) => {
  state.wizardOverview = {
    name: overview?.name || '',
    pitch: overview?.headline || '',
    direction: overview?.summary || '',
    environment: overview?.environment || '',
    skills: overview?.skills || [],
    tools: overview?.tools || [],
  };
  state.wizardValuesSparkIds = [];
  state.wizardValuesCustom = [];
  const progress = await getWizardProgress();
  if (progress && typeof progress === 'object') {
    if (progress.name != null) state.wizardOverview.name = progress.name;
    if (progress.pitch != null) state.wizardOverview.pitch = progress.pitch;
    if (progress.direction != null) state.wizardOverview.direction = progress.direction;
    if (progress.environment != null) state.wizardOverview.environment = progress.environment;
    if (Array.isArray(progress.tools)) state.wizardOverview.tools = progress.tools;
    if (Array.isArray(progress.valuesSparkIds)) state.wizardValuesSparkIds = progress.valuesSparkIds;
    if (Array.isArray(progress.valuesCustom)) state.wizardValuesCustom = progress.valuesCustom;
    state.wizardStep = Math.min(Math.max(1, Number(progress.step) || 1), 7);
  } else {
    state.wizardStep = 1;
  }
};

// ---------- flat form ----------

const renderOverviewFlat = async (el, overview) => {
  const sparks = await listSparks();
  el.innerHTML = `
    <div class="space-y-6">
      <div class="${CLS.card}">
        <div class="${CLS.formHeadRow}">
          <p class="${CLS.eyebrow}">${t('profile.overview.about_eyebrow')}</p>
          ${button({ id: 'btn-redo-intro', variant: 'primaryCompact', icon: 'arrowPath', label: t('profile.action.redo_intro') })}
        </div>
        ${inlineError({ id: 'overview-error' })}
        <div class="grid gap-4">
          ${formField({ type: 'text', name: 'ov-name', label: t('profile.field.name.label'),
                        value: overview?.name || '', placeholder: t('profile.field.name.placeholder'),
                        dataset: { field: 'name' } })}
          ${formField({ type: 'text', name: 'ov-headline', label: t('profile.field.pitch.label'),
                        value: overview?.headline || '',
                        placeholder: t('profile.field.headline.placeholder'),
                        hint: t('profile.field.headline.hint'),
                        dataset: { field: 'headline' } })}
          ${formField({ type: 'textarea', name: 'ov-summary', label: t('profile.field.direction.label'),
                        value: overview?.summary || '', rows: 6,
                        placeholder: t('profile.field.summary.placeholder'),
                        dataset: { field: 'summary' } })}
          <div class="grid gap-2">
            <label class="${CLS.label}">${t('profile.skills.label')}</label>
            ${skillsEditorHtml({ mountId: 'ov-skills-editor', skills: overview?.skills || [] })}
            ${helpText(t('profile.skills.help'))}
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}">${t('profile.field.environment.label')}</label>
            <div id="ov-env-cards" class="${CLS.choiceCardRow}">
              ${envCardsHtml(overview?.environment || '')}
            </div>
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="ov-tools-input">${t('profile.field.tools.label')}</label>
            <div id="ov-tools-list">${toolsListHtml(overview?.tools || [])}</div>
            <div class="flex items-center gap-2">
              <input id="ov-tools-input" type="text" placeholder="${t('profile.tools.placeholder')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
              ${button({ id: 'btn-add-tool', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
            </div>
          </div>
        </div>
      </div>

      <div class="${CLS.card}">
        <div class="${CLS.formHeadRow}">
          <div>
            <p class="${CLS.eyebrow}">${t('profile.sparks.eyebrow')}</p>
            <p class="mt-1 ${CLS.helpText}">${t('profile.sparks.help')}</p>
          </div>
        </div>
        <div id="sparks-list" class="space-y-2">${sparksListHtml(sparks)}</div>
        ${sparkInputHtml()}
      </div>
    </div>
  `;
  wireOverviewFlat(overview);
};

const sparksListHtml = (sparks) => {
  if (!sparks.length) {
    return `${helpText(t('profile.sparks.empty'))}`;
  }
  // "Top priority" = the smallest sort_order present. Any spark at that tier
  // (there may be several tied) is highlighted; the rest render muted.
  const topSort = Math.min(...sparks.map(s => Number(s.sort_order ?? 0)));
  return `<div class="${CLS.chipRow}">${sparks.map(s => sparkPillHtml(s, Number(s.sort_order ?? 0) === topSort)).join('')}</div>`;
};

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
    </select>
    ${button({ id: 'btn-add-spark', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
  </div>
`;

// Environment cards + tools chip editor markup — shared between the flat
// form and (for the cards) the wizard step. envValue is one of
// 'remote'|'hybrid'|'onsite' or '' (nothing selected yet).
const ENV_CHOICES = ['remote', 'hybrid', 'onsite'];

const envCardHtml = (choice, activeValue) => {
  const active = choice === activeValue;
  const palette = active ? CLS.choiceCardActive : CLS.choiceCardInactive;
  return `
    <button type="button" class="${CLS.choiceCardBase} ${palette} js-env-choice" data-env="${choice}" aria-pressed="${active}">
      <span class="${CLS.choiceCardTitle}">${t(`profile.env.card.${choice}.title`)}</span>
      <span class="${CLS.choiceCardHelp}">${t(`profile.env.card.${choice}.help`)}</span>
    </button>
  `;
};

const envCardsHtml = (activeValue) =>
  ENV_CHOICES.map(c => envCardHtml(c, activeValue)).join('');

const toolPillHtml = (name) => removablePill({
  label: name,
  color: 'slate',
  classes: 'gap-1.5',
  dataset: { tool: name },
  dismissClass: 'js-tool-delete',
  dismissLabel: t('common.action.delete'),
});

const toolsListHtml = (tools) => tools.length
  ? `<div class="${CLS.chipRow}">${tools.map(toolPillHtml).join('')}</div>`
  : `${helpText(t('profile.tools.empty'))}`;

const wireOverviewFlat = (overview) => {
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
    await clearWizardProgress();
    const fresh = await getOverview();
    await seedWizardStateFrom(fresh);
    state.wizardStep = 1;
    renderWizard(document.getElementById('tab-content'));
  });

  wireSparkInput();
  wireSparks();

  // Wire the skills editor on the flat form: any change flushes to the DB.
  // Initial skills come from the overview snapshot captured at render time.
  wireSkillsEditor('ov-skills-editor', overview?.skills || [], async (skills) => {
    await updateOverview({ skills });
  });

  // Environment cards — clicking a card commits immediately and rerenders
  // the row so the active palette moves. Clicking the already-active card
  // clears the selection.
  const rerenderEnvCards = (value) => {
    const mount = document.getElementById('ov-env-cards');
    if (!mount) return;
    mount.innerHTML = envCardsHtml(value);
    wireEnvCards();
  };
  const wireEnvCards = () => {
    document.querySelectorAll('#ov-env-cards .js-env-choice').forEach(btn => {
      btn.addEventListener('click', async () => {
        const current = overview?.environment || '';
        const clicked = btn.dataset.env;
        const next = current === clicked ? '' : clicked;
        overview.environment = next;
        try { await updateOverview({ environment: next }); }
        catch (err) { setInlineError('overview-error', err.message || String(err)); return; }
        rerenderEnvCards(next);
      });
    });
  };
  wireEnvCards();

  // Tools chip editor — Enter or click Add appends a normalized tool string;
  // × on a pill removes it. Each mutation flushes to the DB.
  let tools = [...(overview?.tools || [])];
  const rerenderTools = () => {
    const listEl = document.getElementById('ov-tools-list');
    if (!listEl) return;
    listEl.innerHTML = toolsListHtml(tools);
    listEl.querySelectorAll('.js-tool-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.tool;
        tools = tools.filter(x => x !== name);
        try { await updateOverview({ tools }); }
        catch (err) { setInlineError('overview-error', err.message || String(err)); return; }
        rerenderTools();
      });
    });
  };
  const addTool = async () => {
    const input = document.getElementById('ov-tools-input');
    const val = (input.value || '').trim();
    if (!val) return;
    if (!tools.includes(val)) tools.push(val);
    input.value = '';
    try { await updateOverview({ tools }); }
    catch (err) { setInlineError('overview-error', err.message || String(err)); return; }
    rerenderTools();
    input.focus();
  };
  document.getElementById('ov-tools-input')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addTool(); }
  });
  document.getElementById('btn-add-tool')?.addEventListener('click', addTool);
  rerenderTools();
};

// ---------- skills editor ----------
// Shared by the flat form and the wizard: renders a pill list + input row;
// wireSkillsEditor invokes onChange(skills[]) on every mutation.

const SKILL_LEVEL_COLOR = {
  expert:       'emerald',
  advanced:     'blue',
  intermediate: 'amber',
  beginner:     'slate',
};

// Map a stored level enum to its localized display label. Colors key off the
// enum, so translation only affects the visible text.
const skillLevelLabel = (level) =>
  level && SKILL_LEVELS.includes(level) ? t(`profile.skill.level.${level}`) : '';

const skillPillHtml = (s, i) => {
  const color = SKILL_LEVEL_COLOR[s.level] || 'slate';
  const suffix = [];
  if (s.years != null) suffix.push(`${s.years}y`);
  if (s.level) suffix.push(skillLevelLabel(s.level));
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
      <input type="number" class="${CLS.inputBase} w-24 shrink-0 px-2 text-center js-skill-years"
             min="0" step="0.5" placeholder="${t('profile.skills.years_placeholder')}" title="${t('profile.skills.years_title')}" />
      <select class="${CLS.inputBase} w-32 shrink-0 js-skill-level" title="${t('profile.skills.level_title')}">
        <option value="">—</option>
        ${SKILL_LEVELS.map(lvl => `<option value="${lvl}">${skillLevelLabel(lvl)}</option>`).join('')}
      </select>
      ${button({ variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add'), extraClass: 'js-add-skill' })}
    </div>
    <div class="js-skill-pills flex flex-wrap gap-2">
      ${skills.length
        ? skills.map((s, i) => skillPillHtml(s, i)).join('')
        : `${helpText(t('profile.skills.empty'))}`}
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
      : `${helpText(t('profile.skills.empty'))}`;
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

// Wire the shared "type a spark and press Enter" input on the flat form.
const wireSparkInput = () => {
  const input = document.getElementById('spark-input');
  const priority = document.getElementById('spark-priority');
  const addBtn = document.getElementById('btn-add-spark');
  if (!input || !addBtn) return;

  const submit = async () => {
    const val = input.value.trim();
    if (!val) return;
    const p = priority ? Number(priority.value) : undefined;
    await createSpark(val, p);
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

const rerenderSparksList = async () => {
  const listEl = document.getElementById('sparks-list');
  if (!listEl) return;
  const all = await listSparks();
  listEl.innerHTML = sparksListHtml(all);
  wireSparks();
};

const wireSparks = () => {
  const listEl = document.getElementById('sparks-list');
  if (!listEl) return;
  listEl.querySelectorAll('.js-spark-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.sparkId);
      await deleteSpark(id);
      await rerenderSparksList();
    });
  });
};

// Bundle page state + shared helpers so profile_wizard.mjs can render
// without circular imports.
const renderWizard = async (mountEl) => renderWizardModule({
  state,
  mountEl,
  renderOverviewTab,
  skillsEditorHtml,
  wireSkillsEditor,
  envCardsHtml,
  toolsListHtml,
});

// ============================================================================
// RESUMES TAB
// ============================================================================

const renderResumesTab = async (el) => {
  el.innerHTML = `${helpText(t('app.loading'))}`;
  refreshProfileTabCounts();
  const resumes = await listResumes();
  el.innerHTML = `
    <div class="space-y-6">
      <section class="flex items-center justify-between">
        ${helpText(t('profile.resumes.help'))}
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
      <li class="${CLS.paperCard}">
        <div class="${CLS.cardHeadRow}">
          <div class="${CLS.textCol}">
            <div class="${CLS.chipRowInline}">
              <span class="font-semibold text-ink">${escapeHtml(r.title || t('profile.resumes.untitled'))}</span>
              ${badge({ label: r.format === 'typ' ? t('profile.resumes.format.typst') : t('profile.resumes.format.markdown'), color: r.format === 'typ' ? 'violet' : 'slate', size: 'xs' })}
              ${r.is_primary ? badge({ label: t('profile.resumes.primary'), color: 'emerald', size: 'xs' }) : ''}
            </div>
            <p class="${CLS.helpText}">${t('common.updated_at', { date: formatDate(r.updated_at) })}</p>
          </div>
          <div class="${CLS.headActions}">
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
        <div class="${CLS.formHeadRow}">
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

      <div id="typst-panel" class="${r.format === 'typ' ? '' : 'hidden'} space-y-3 ${CLS.dividerTop}">
        ${inlineError({ id: 'compile-error' })}
        <div class="flex items-center gap-2">
          ${button({ id: 'btn-compile', variant: 'secondaryCompact', icon: 'sparkles', label: t('profile.resumes.action.compile') })}
          <span id="compile-status" class="${CLS.helpText}"></span>
        </div>
        <div id="pdf-preview" class="hidden">
          <iframe id="pdf-iframe" class="h-96 w-full rounded-xl border border-line" title="${t('profile.resumes.pdf_preview_title')}"></iframe>
          <div class="mt-2 flex items-center gap-2">
            ${button({ id: 'btn-attach-pdf', variant: 'primaryCompact', icon: 'arrowUpTray', label: t('profile.resumes.action.attach') })}
            ${button({ id: 'btn-download-pdf', variant: 'secondaryCompact', icon: 'arrowDownTray', label: t('profile.resumes.action.download') })}
          </div>
        </div>
        ${logPanel({ id: 'compile-log' })}
      </div>

      <div class="${CLS.dividerTop}">
        <p class="${CLS.eyebrow}">${t('profile.resumes.sent.eyebrow')}</p>
        <div id="sent-pdfs" class="mt-3">${sentPdfsHtml(pdfList)}</div>
      </div>
    </div>
  `;

  wireResumeEditor();
};

const sentPdfsHtml = (rows) => {
  if (!rows.length) return `${helpText(t('profile.resumes.sent.empty'))}`;
  return `<ul class="space-y-2">${rows.map(r => `
    <li class="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2 text-sm">
      <div class="min-w-0">
        <p class="truncate font-medium text-ink">${escapeHtml(r.original_filename || r.filename)}</p>
        <p class="${CLS.helpText}">${r.application_role_title
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
  dlg.className = 'fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4';
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
  el.innerHTML = `${helpText(t('app.loading'))}`;
  refreshProfileTabCounts();
  const [entries, companies] = await Promise.all([listBragEntries(), listCompanies()]);
  el.innerHTML = `
    <div class="space-y-6">
      <section class="flex items-center justify-between">
        ${helpText(t('profile.brags.help'))}
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
      <li class="${CLS.paperCard}">
        <div class="${CLS.cardHeadRow}">
          <div class="${CLS.textCol}">
            <div class="${CLS.chipRowInline}">
              <p class="font-semibold text-ink">${escapeHtml(e.title || t('profile.brags.untitled'))}</p>
              ${e.entry_date ? badge({ label: String(e.entry_date).slice(0, 4), color: 'violet', size: 'xs' }) : ''}
            </div>
            <p class="line-clamp-1 ${CLS.bodyText}">${escapeHtml(e.body)}</p>
            ${e.impact ? `<p class="line-clamp-1 ${CLS.winText}">${t('profile.brags.impact', { text: escapeHtml(e.impact) })}</p>` : ''}
            <div class="flex flex-wrap items-center gap-2 pt-1">
              ${e.company_name ? badge({ label: e.company_name, color: 'blue', size: 'xs' }) : ''}
              ${(e.tags || []).map(tag => badge({ label: tag, color: 'slate', size: 'xs' })).join('')}
            </div>
            ${e.tags_generated_at ? `<p class="${CLS.helpText}">${t('profile.brags.tags_updated', { date: formatDate(e.tags_generated_at) })}</p>` : ''}
          </div>
          <div class="${CLS.headActions}">
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
        <div class="${CLS.formHeadRow}">
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
          <div id="brag-tags-progress" class="hidden"></div>
          <div id="brag-tags-list"></div>
          <div class="flex items-center gap-2">
            <input id="brag-tag-input" type="text" placeholder="${t('profile.brags.tags.placeholder')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
            ${button({ id: 'btn-add-brag-tag', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
          </div>
          <p id="brag-tags-updated" class="text-xs text-ink-faint hidden"></p>
        </div>
      </form>
    </div>
  `;
  const form = document.getElementById('brag-form');
  const normalizeTag = (tag) => String(tag || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const renderTagList = () => {
    const listEl = document.getElementById('brag-tags-list');
    listEl.innerHTML = state.bragDraftTags.length
      ? `<div class="${CLS.chipRow}">${state.bragDraftTags.map(bragTagPillHtml).join('')}</div>`
      : `${helpText(t('profile.brags.tags.empty'))}`;
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
    const progress = createProgress(document.getElementById('brag-tags-progress'));
    progress.reset();
    try {
      setInlineError('brag-tags-error', '');
      const body = document.getElementById('brag-body').value;
      if (!body.trim()) {
        setInlineError('brag-tags-error', t('profile.brags.error.description_required'));
        return;
      }
      const out = await generateBragTags({ body }, '', progress.asCallback());
      state.bragDraftTags = Array.isArray(out?.tags) ? out.tags : [];
      state.bragPendingTagsGeneratedAt = new Date().toISOString();
      renderTagList();
      progress.reset();
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
