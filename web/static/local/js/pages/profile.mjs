// Career profile page — Overview, Resumes, Brag Sheet. On first run
// (onboarded_at NULL + all fields empty) the Overview tab hosts the 7-step
// setup wizard (see profile_wizard.mjs) instead of the flat form.

import { CLS } from '../ui/classes.mjs';
import { escapeHtml, formatDate } from '../ui/dom.mjs';
import { button, pageHeader, formField, emptyState, fileRow, helpText, inlineError, inlineNote, setInlineError, badge, tab, removablePill } from '../ui/components.mjs';
import { collectionRowsHtml } from '../ui/collection_list.mjs';
import { relativeAge } from '../ui/format.mjs';
import { toast } from '../ui/toast.mjs';
import { t } from '../i18n.mjs';
import {
  getOverview, updateOverview, clearOnboarded, SKILL_LEVELS,
  getWizardProgress, clearWizardProgress,
} from '../entities/profile-overview.mjs';
import {
  listSparks, createSpark, deleteSpark, countSparks,
} from '../entities/career-sparks.mjs';
import { listResumes, countResumes } from '../entities/resumes.mjs';
import {
  listBragEntries, createBragEntry, updateBragEntry, deleteBragEntry, countBragEntries,
} from '../entities/brag-entries.mjs';
import { listCompanies } from '../entities/companies.mjs';
import { generateBragTags } from '../rpc.mjs';
import { createProgress } from '../ui/progress.mjs';
import { renderWizard as renderWizardModule } from './profile_wizard.mjs';
import { renderImport } from './profile-import.mjs';
import { openResumePanel } from './profile-resume-panel.mjs';

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
// Import is a virtual view rendered inside the tab-content area. It never
// appears in the tab strip but is a valid `state.tab` value so its state
// round-trips through the `?tab=import` URL param.
const IMPORT_TAB = 'import';
const VALID_TABS = [...TAB_NAMES, IMPORT_TAB];
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
      ${button({ id: 'btn-import', variant: 'subtle', icon: 'sparkles', label: t('profile.action.import') })}
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
  if (!VALID_TABS.includes(tab)) tab = 'overview';
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
  if (state.tab === IMPORT_TAB) return renderImport({ mountEl: el, onExit: (tab = 'overview') => setTab(tab) });
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
            <div class="${CLS.inlineRow}">
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
  <div class="${CLS.inlineRow}">
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
    <div class="${CLS.inlineRow}">
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
      <section id="resume-list">
        ${collectionRowsHtml({
          rows: resumes.map(resumeFileRow),
          emptyMessage: t('profile.resumes.empty'),
        })}
      </section>
      <section id="resume-panel" class="hidden"></section>
    </div>
  `;
  document.getElementById('btn-new-resume').addEventListener('click', (ev) => launchResumePanel(null, ev.currentTarget));
  document.querySelectorAll('.js-open-resume').forEach((b) => {
    b.addEventListener('click', () => launchResumePanel(Number(b.dataset.id), b));
  });
};

// launchResumePanel opens the slide-over and refreshes the list when it
// closes with any observable change (save / delete / attach).
const launchResumePanel = (resumeId, triggerEl) => {
  openResumePanel({
    resumeId,
    triggerEl,
    onClose: (report) => {
      if (report?.saved || report?.deleted || report?.attached) {
        renderResumesTab(document.getElementById('tab-content'));
      }
    },
  });
};

// Row matches the collection-index pattern (companies/applications/people):
// single click-to-open button, one pill slot (format + optional primary
// badge), one meta line. All row-level actions live in the slide-over.
const resumeFileRow = (r) => {
  const title = r.title || t('profile.resumes.untitled');
  const formatBadge = badge({
    label: r.format === 'typ' ? t('profile.resumes.format.typst') : t('profile.resumes.format.markdown'),
    color: r.format === 'typ' ? 'violet' : 'slate',
    size: 'xs',
  });
  const primaryBadge = r.is_primary
    ? badge({ label: t('profile.resumes.primary'), color: 'emerald', size: 'xs' })
    : '';
  return fileRow({
    id: r.id,
    jsClass: 'js-open-resume',
    ariaLabel: t('profile.resumes.aria.open', { title }),
    title,
    pill: `${formatBadge}${primaryBadge}`,
    meta: t('common.updated_at', { date: relativeAge(r.updated_at) }),
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
      ${inlineNote({ message: t('profile.brags.help_quote') })}
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
              ${e.entry_year ? badge({ label: String(e.entry_year), color: 'violet', size: 'xs' }) : ''}
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
  const e = entry || { title: '', body: '', impact: '', tags: [], tags_generated_at: null, company_id: null, entry_year: null };
  if (!state.bragDraftTags.length) state.bragDraftTags = [...(e.tags || [])];
  editorEl.innerHTML = `
    <div class="${CLS.card}">
      <form id="brag-form" class="space-y-4">
        <div class="${CLS.formHeadRow}">
          <p class="${CLS.eyebrow}">${isNew ? t('profile.brags.form.new_eyebrow') : t('profile.brags.form.edit_eyebrow')}</p>
          <div class="${CLS.inlineRow}">
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
        <div class="${CLS.gridTwoCol} gap-4">
          ${formField({ type: 'select', name: 'brag-company', label: t('profile.brags.field.company.label'),
                        options: [
                          { value: '', label: t('common.status.none'), selected: !e.company_id },
                          ...companies.map(c => ({
                            value: String(c.id),
                            label: c.official_name,
                            selected: c.id === e.company_id,
                          })),
                        ] })}
          ${formField({ type: 'number', name: 'brag-year', label: t('profile.brags.field.year.label'),
                        value: e.entry_year ? String(e.entry_year) : '',
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
          <div class="${CLS.inlineRow}">
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
      entry_year: (() => {
        const raw = document.getElementById('brag-year').value.trim();
        return /^\d{4}$/.test(raw) ? Number(raw) : null;
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
  // Optional deep-link: /local/profile?tab=resumes | ?tab=import
  const params = new URLSearchParams(window.location.search);
  const initialTab = params.get('tab');
  if (initialTab && VALID_TABS.includes(initialTab)) state.tab = initialTab;

  appEl.innerHTML = shellHtml();
  wireTabStrip();
  document.getElementById('btn-import')?.addEventListener('click', () => setTab(IMPORT_TAB));
  refreshProfileTabCounts();
  renderTab();
};
