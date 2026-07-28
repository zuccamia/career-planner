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
const TABS = {
  overview: 'Overview',
  resumes: 'Resumes',
  brag: 'Brag Sheet',
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
      ${pageHeader({ title: 'Profile', tagline: 'Who you are, what you want, and the material to tailor from.' })}
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
  label: TABS[name],
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
  el.innerHTML = `<p class="text-sm text-slate-500">Loading profile…</p>`;
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
          <p class="${CLS.eyebrow}">About you</p>
          ${button({ id: 'btn-redo-intro', variant: 'primaryCompact', icon: 'arrowPath', label: 'Redo intro' })}
        </div>
        ${inlineError({ id: 'overview-error' })}
        <div class="grid gap-4">
          ${formField({ type: 'text', name: 'ov-name', label: 'Name',
                        value: overview?.name || '', placeholder: 'Your name',
                        dataset: { field: 'name' } })}
          ${formField({ type: 'text', name: 'ov-headline', label: 'Headline',
                        value: overview?.headline || '',
                        placeholder: 'Backend engineer, data pipelines',
                        hint: 'A one-line snapshot of who you are and the work you want to be known for.',
                        dataset: { field: 'headline' } })}
          ${formField({ type: 'textarea', name: 'ov-summary', label: 'Summary',
                        value: overview?.summary || '', rows: 6,
                        placeholder: 'What kind of work do you want to do next?',
                        dataset: { field: 'summary' } })}
          <div class="grid gap-2">
            <label class="${CLS.label}">Skills</label>
            ${skillsEditorHtml({ mountId: 'ov-skills-editor', skills: overview?.skills || [] })}
            <p class="text-xs text-slate-500">A stable "glossary" the AI can pull from when tailoring. Years and level are optional — leave blank if unsure.</p>
          </div>
        </div>
      </div>

      <div class="${CLS.card}">
        <div class="flex items-baseline justify-between">
          <div>
            <p class="${CLS.eyebrow}">Career priorities (sparks)</p>
            <p class="mt-1 text-sm text-slate-500">What matters most to you in a role. Set a priority (P1 = top) when adding each spark; several sparks can share the same tier. Sparks at your top tier are <span class="font-medium text-slate-700">highlighted</span> — the AI weights them most when tailoring resumes and outreach.</p>
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
    return `<p class="text-sm text-slate-400">No sparks yet. Add a few to tell the AI what matters most to you.</p>`;
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
    dismissLabel: 'Remove spark',
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
    <input id="spark-input" type="text" placeholder="Type a spark and press Enter" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
    <select id="spark-priority" title="Priority (P1 = top)" class="${CLS.inputBase} w-24 shrink-0">
      <option value="1">P1 top</option>
      <option value="2">P2</option>
      <option value="3" selected>P3</option>
      <option value="4">P4</option>
      <option value="5">P5</option>
    </select>
    ${button({ id: 'btn-add-spark', variant: 'secondaryCompact', icon: 'plus', label: 'Add' })}
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
      <input type="text" class="${CLS.inputBase} flex-1 min-w-0 js-skill-name" placeholder="Skill name (Enter to add)" autocomplete="off" />
      <input type="number" class="${CLS.inputBase} w-16 shrink-0 px-2 text-center js-skill-years"
             min="0" step="0.5" placeholder="Yrs" title="Years of experience (optional)" />
      <select class="${CLS.inputBase} w-32 shrink-0 js-skill-level" title="Self-rated level (optional)">
        <option value="">—</option>
        ${SKILL_LEVELS.map(lvl => `<option value="${lvl}">${capitalize(lvl)}</option>`).join('')}
      </select>
      ${button({ variant: 'secondaryCompact', icon: 'plus', label: 'Add', extraClass: 'js-add-skill' })}
    </div>
    <div class="js-skill-pills flex flex-wrap gap-2">
      ${skills.length
        ? skills.map((s, i) => skillPillHtml(s, i)).join('')
        : '<p class="text-sm text-slate-400">No skills yet.</p>'}
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
      : '<p class="text-sm text-slate-400">No skills yet.</p>';
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
const SPARK_THEMES = {
  5: {
    title: 'Work environment',
    prompt: 'Where and how do you want to work?',
    hints: 'Remote / hybrid / in-person? Team size? Pace? Timezone constraints?',
    chips: ['remote-friendly', 'async-first', 'small team (<15)', 'hybrid ok'],
  },
  6: {
    title: 'What matters most',
    prompt: 'What values or conditions matter to you?',
    hints: 'Autonomy, mission, learning, compensation, work-life? Anything that would be a dealbreaker?',
    chips: ['high-agency', 'ships weekly', 'mission-driven', 'mentorship available'],
  },
  7: {
    title: 'Craft & tools',
    prompt: 'Any tools, languages, or areas you especially enjoy — or want to avoid?',
    hints: "Languages, frameworks, domains you're drawn to. It's fine to name things you'd rather not touch.",
    chips: ['Go', 'TypeScript', 'data pipelines', 'no on-call'],
  },
};

const renderWizard = async (el) => {
  const step = state.wizardStep;
  const dots = Array.from({ length: WIZARD_STEPS }, (_, i) =>
    `<span class="inline-block h-2 w-2 rounded-full ${i < step ? 'bg-blue-600' : 'bg-slate-200'}"></span>`,
  ).join(' ');

  let body = '';
  if (step === 1) body = wizardTextStep({ label: 'Your name', hint: "What you'd like to see in your resume header.", field: 'name', placeholder: 'Your name', multiline: false });
  else if (step === 2) body = wizardTextStep({ label: 'Your one-line pitch', hint: 'A one-line snapshot of who you are and the work you want to be known for.', field: 'headline', placeholder: 'Backend engineer, data pipelines', multiline: false, examples: [
    'Senior accountant, month-end close and consolidations',
    'Data analyst focused on growth experimentation',
    'Frontend engineer, design systems',
    'Product manager, developer platforms',
    'Registered nurse, cardiac step-down',
  ] });
  else if (step === 3) body = wizardTextStep({ label: 'What kind of work do you want to do next?', hint: 'A paragraph is fine — write it for yourself, not a recruiter.', field: 'summary', placeholder: "Picture the work that would make you glad you spent the year on it. What are you building, who's it for, and what did you get to be good at along the way?", multiline: true });
  else if (step === 4) body = wizardSkillsStep();
  else if (step >= 5 && step <= 7) body = await wizardSparkStep(SPARK_THEMES[step]);
  else if (step === 8) body = await wizardRecapStep();

  el.innerHTML = `
    <div class="${CLS.card} max-w-2xl mx-auto">
      <div class="flex items-center justify-between">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Set up your profile · Step ${step} of ${WIZARD_STEPS}</p>
        <div class="flex gap-1.5" aria-hidden="true">${dots}</div>
      </div>
      ${inlineError({ id: 'wizard-error' })}
      <div class="pt-2">${body}</div>
      <div class="flex items-center justify-between pt-4">
        <div>
          ${step > 1 ? button({ id: 'btn-wizard-back', variant: 'secondaryCompact', label: 'Back' }) : ''}
        </div>
        <div class="flex gap-2">
          ${step < WIZARD_STEPS ? button({ id: 'btn-wizard-skip', variant: 'linkMuted', label: step <= 4 ? 'Skip setup' : 'Skip this' }) : ''}
          ${step < WIZARD_STEPS
            ? button({ id: 'btn-wizard-next', variant: 'primaryCompact', label: 'Next →' })
            : button({ id: 'btn-wizard-done', variant: 'primaryCompact', icon: 'check', label: 'Looks good' })}
        </div>
      </div>
    </div>
  `;
  wireWizard(el);
};

const wizardSkillsStep = () => `
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-slate-900">Your top skills</h2>
      <p class="mt-1 text-sm text-slate-500">Add each skill with optional years and self-rated level. The AI uses this as a stable "glossary" when tailoring — level and years let it emphasize your strongest bets.</p>
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
          <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Already on file</p>
          <p class="text-xs text-slate-500">Kept from previous entries — the AI still sees them. Click × to remove any that no longer fit.</p>
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
      <p class="text-sm text-slate-900">${val ? escapeHtml(val) : '<span class="text-slate-400">— not set —</span>'}</p>
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
    : `<p class="text-sm text-slate-400">— none —</p>`;
  const sparkList = sparks.length
    ? `<ul class="mt-1 space-y-1 text-sm text-slate-900">${sparks.map(s => `<li>· ${escapeHtml(s.body)}</li>`).join('')}</ul>`
    : `<p class="text-sm text-slate-400">— none —</p>`;
  return `
    <div class="space-y-4">
      <h2 class="text-lg font-semibold text-slate-900">Your profile</h2>
      ${line('Name', ov?.name)}
      ${line('Headline', ov?.headline)}
      ${line('Summary', ov?.summary)}
      <div class="grid gap-1">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Skills</p>
        ${skillsList}
      </div>
      <div class="grid gap-1">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Career sparks</p>
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
    // Text steps (1–4) treat Skip as "opt out of the whole wizard"; themed
    // spark steps (5–7) treat Skip as "advance to the next theme."
    if (step <= 4) {
      await persistWizardTextIfAny();
      await markOnboarded();
      renderOverviewTab(el);
    } else {
      state.wizardStep = step + 1;
      renderWizard(el);
    }
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
  el.innerHTML = `<p class="text-sm text-slate-500">Loading resumes…</p>`;
  refreshProfileTabCounts();
  const resumes = await listResumes();
  el.innerHTML = `
    <div class="space-y-6">
      <section class="flex items-center justify-between">
        <p class="text-sm text-slate-500">Store the source (markdown or Typst). Typst resumes compile to PDF in-browser and can be attached to an application.</p>
        ${button({ id: 'btn-new-resume', variant: 'primaryCompact', icon: 'plus', label: 'Resume', ariaLabel: 'Add resume' })}
      </section>
      <section id="resume-editor" class="${state.resumeEditorId || state.resumeEditorNew ? '' : 'hidden'}"></section>
      <section id="resume-list" class="${CLS.card}">
        ${resumes.length ? resumesListHtml(resumes) : emptyState({ message: 'No resumes yet. Create one to get started.' })}
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
              <span class="font-semibold text-slate-900">${escapeHtml(r.title || '(untitled)')}</span>
              ${badge({ label: r.format === 'typ' ? 'Typst' : 'Markdown', color: r.format === 'typ' ? 'violet' : 'slate', size: 'xs' })}
              ${r.is_primary ? badge({ label: 'Primary', color: 'emerald', size: 'xs' }) : ''}
            </div>
            <p class="text-xs text-slate-500">Updated ${formatDate(r.updated_at)}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${r.is_primary
              ? ''
              : button({ variant: 'secondaryCompact', label: 'Set primary', extraClass: 'js-primary', dataset: { id: r.id } })}
            ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: 'Edit', extraClass: 'js-edit-resume', dataset: { id: r.id } })}
            ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: 'Delete', extraClass: 'js-delete-resume', dataset: { id: r.id, title: r.title || '(untitled)' } })}
          </div>
        </div>
      </li>
    `).join('')}
  </ul>
`;

const wireResumesList = () => {
  document.querySelectorAll('.js-edit-resume').forEach(b => b.addEventListener('click', () => openResumeEditor(Number(b.dataset.id))));
  document.querySelectorAll('.js-delete-resume').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Delete resume "${b.dataset.title}"?`)) return;
    await deleteResume(Number(b.dataset.id));
    if (state.resumeEditorId === Number(b.dataset.id)) closeResumeEditor();
    toast('Resume deleted', 'ok');
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
          <p class="${CLS.eyebrow}">${isNew ? 'New resume' : 'Edit resume'}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: 'Save' })}
            ${button({ id: 'btn-close-resume', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel' })}
          </div>
        </div>
        ${inlineError({ id: 'resume-error' })}
        <div class="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          ${formField({ type: 'text', name: 'res-title', label: 'Title',
                        value: r.title, required: true,
                        placeholder: 'e.g. Senior accountant resume — or Backend engineer resume' })}
          ${formField({ type: 'select', name: 'res-format', label: 'Format',
                        options: [
                          { value: 'md',  label: 'Markdown (.md)', selected: r.format === 'md' },
                          { value: 'typ', label: 'Typst (.typ)',   selected: r.format === 'typ' },
                        ] })}
        </div>
        ${formField({ type: 'textarea', name: 'res-body', label: 'Source',
                      value: r.body, rows: 25, extraClass: 'font-mono text-xs',
                      placeholder: 'Paste your resume source here…' })}
      </form>

      <div id="typst-panel" class="${r.format === 'typ' ? '' : 'hidden'} space-y-3 border-t border-slate-200 pt-4">
        ${inlineError({ id: 'compile-error' })}
        <div class="flex items-center gap-2">
          ${button({ id: 'btn-compile', variant: 'secondaryCompact', icon: 'sparkles', label: 'Compile to PDF' })}
          <span id="compile-status" class="text-xs text-slate-500"></span>
        </div>
        <div id="pdf-preview" class="hidden">
          <iframe id="pdf-iframe" class="h-96 w-full rounded-xl border border-slate-200" title="PDF preview"></iframe>
          <div class="mt-2 flex items-center gap-2">
            ${button({ id: 'btn-attach-pdf', variant: 'primaryCompact', icon: 'arrowUpTray', label: 'Attach to application' })}
            ${button({ id: 'btn-download-pdf', variant: 'secondaryCompact', icon: 'arrowDownTray', label: 'Download' })}
          </div>
        </div>
        <div id="compile-log" class="hidden max-h-40 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] text-slate-700"></div>
      </div>

      <div class="border-t border-slate-200 pt-4">
        <p class="${CLS.eyebrow}">PDFs sent from this resume</p>
        <div id="sent-pdfs" class="mt-3">${sentPdfsHtml(pdfList)}</div>
      </div>
    </div>
  `;

  wireResumeEditor();
};

const sentPdfsHtml = (rows) => {
  if (!rows.length) return `<p class="text-xs text-slate-500">None yet. Compile a PDF above and attach it to an application.</p>`;
  return `<ul class="space-y-2">${rows.map(r => `
    <li class="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
      <div class="min-w-0">
        <p class="truncate font-medium text-slate-900">${escapeHtml(r.original_filename || r.filename)}</p>
        <p class="text-xs text-slate-500">${r.application_role_title
          ? `Sent to ${escapeHtml(r.application_role_title)}${r.application_company_name ? ` · ${escapeHtml(r.application_company_name)}` : ''}`
          : 'Application deleted'} · ${formatDate(r.created_at)}${r.size_bytes ? ' · ' + formatBytes(r.size_bytes) : ''}</p>
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
      setInlineError('resume-error', 'Title is required');
      return;
    }
    try {
      if (state.resumeEditorId) {
        await updateResume(state.resumeEditorId, data);
        toast('Resume saved', 'ok');
      } else {
        const id = await createResume(data);
        state.resumeEditorId = id;
        state.resumeEditorNew = false;
        toast(`Created resume #${id}`, 'ok');
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
  if (!source.trim()) { setInlineError('compile-error', 'Nothing to compile — resume body is empty'); return; }
  status.textContent = 'Compiling… (first run loads the Typst engine)';
  preview.classList.add('hidden');
  logEl.classList.add('hidden');
  try {
    const { pdf, log } = await compileTypstToPdf(source);
    if (state.resumePdfUrl) URL.revokeObjectURL(state.resumePdfUrl);
    state.resumePdfBlob = new Blob([pdf], { type: 'application/pdf' });
    state.resumePdfUrl = URL.createObjectURL(state.resumePdfBlob);
    iframe.src = state.resumePdfUrl;
    preview.classList.remove('hidden');
    status.textContent = `Compiled ${formatBytes(state.resumePdfBlob.size)}`;
    if (log) {
      logEl.textContent = log;
      logEl.classList.remove('hidden');
    }
  } catch (err) {
    status.textContent = '';
    setInlineError('compile-error', `Compile failed: ${err.message || String(err)}`);
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
    setInlineError('resume-error', 'Compile the PDF first');
    return;
  }
  const [apps, companies] = await Promise.all([listApplications(), listCompanies()]);
  if (!apps.length) {
    setInlineError('resume-error', 'No applications yet — create one first');
    return;
  }
  const companyById = new Map(companies.map(c => [c.id, c]));
  const dlg = document.createElement('div');
  dlg.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4';
  dlg.innerHTML = `
    <div class="${CLS.card} w-full max-w-md">
      <div class="flex items-baseline justify-between">
        <p class="${CLS.eyebrow}">Attach PDF to application</p>
        <button type="button" id="btn-cancel-attach" class="text-slate-400 hover:text-slate-900" aria-label="Cancel">×</button>
      </div>
      ${inlineError({ id: 'attach-error' })}
      <div class="grid gap-2">
        <label class="${CLS.label}" for="attach-app">Application</label>
        <select id="attach-app" class="${CLS.select}">
          ${apps.map(a => {
            const co = companyById.get(a.company_id);
            const label = `${a.role_title || '(no title)'} — ${co?.official_name || 'unknown'}`;
            return `<option value="${a.id}" data-company="${escapeHtml(co?.official_name || '')}">${escapeHtml(label)}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        ${button({ id: 'btn-cancel-attach-2', variant: 'secondaryCompact', label: 'Cancel' })}
        ${button({ id: 'btn-confirm-attach', variant: 'primaryCompact', icon: 'check', label: 'Attach' })}
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('#btn-cancel-attach').addEventListener('click', close);
  dlg.querySelector('#btn-cancel-attach-2').addEventListener('click', close);
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
      toast(`Attached ${meta.storedFilename}`, 'ok');
      await mountResumeEditor();
    } catch (err) {
      setInlineError('attach-error', err.message || String(err));
    }
  });
};

// ============================================================================
// BRAG SHEET TAB
// ============================================================================

const renderBragTab = async (el) => {
  el.innerHTML = `<p class="text-sm text-slate-500">Loading brag sheet…</p>`;
  refreshProfileTabCounts();
  const [entries, companies] = await Promise.all([listBragEntries(), listCompanies()]);
  el.innerHTML = `
    <div class="space-y-6">
      <section class="flex items-center justify-between">
        <p class="text-sm text-slate-500">Small accomplishments you'll want to remember when the AI tailors a resume.</p>
        ${button({ id: 'btn-new-brag', variant: 'primaryCompact', icon: 'plus', label: 'Brag', ariaLabel: 'Add brag entry' })}
      </section>
      <section id="brag-editor" class="${state.bragEditorId || state.bragEditorNew ? '' : 'hidden'}"></section>
      <section id="brag-list" class="${CLS.card}">
        ${entries.length ? bragListHtml(entries) : emptyState({ message: 'No brag entries yet. Log a win and it will surface when you tailor resumes for that company.' })}
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
              <p class="font-semibold text-slate-900">${escapeHtml(e.title || '(untitled)')}</p>
              ${e.entry_date ? badge({ label: String(e.entry_date).slice(0, 4), color: 'violet', size: 'xs' }) : ''}
            </div>
            <p class="line-clamp-1 text-sm text-slate-700">${escapeHtml(e.body)}</p>
            ${e.impact ? `<p class="line-clamp-1 text-sm font-medium text-emerald-700">Impact: ${escapeHtml(e.impact)}</p>` : ''}
            <div class="flex flex-wrap items-center gap-2 pt-1">
              ${e.company_name ? badge({ label: e.company_name, color: 'blue', size: 'xs' }) : ''}
              ${(e.tags || []).map(t => badge({ label: t, color: 'slate', size: 'xs' })).join('')}
            </div>
            ${e.tags_generated_at ? `<p class="text-xs text-slate-500">Tag suggestions updated ${escapeHtml(formatDate(e.tags_generated_at))}</p>` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: 'Edit', extraClass: 'js-edit-brag', dataset: { id: e.id } })}
            ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: 'Delete', extraClass: 'js-delete-brag', dataset: { id: e.id, title: e.title || '(untitled)' } })}
          </div>
        </div>
      </li>
    `).join('')}
  </ul>
`;

const wireBragList = () => {
  document.querySelectorAll('.js-edit-brag').forEach(b => b.addEventListener('click', () => openBragEditor(Number(b.dataset.id))));
  document.querySelectorAll('.js-delete-brag').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Delete brag entry "${b.dataset.title}"?`)) return;
    await deleteBragEntry(Number(b.dataset.id));
    if (state.bragEditorId === Number(b.dataset.id)) closeBragEditor();
    toast('Brag entry deleted', 'ok');
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
          <p class="${CLS.eyebrow}">${isNew ? 'New brag entry' : 'Edit brag entry'}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: 'Save' })}
            ${button({ id: 'btn-close-brag', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel' })}
          </div>
        </div>
        ${inlineError({ id: 'brag-error' })}
        ${formField({ type: 'text', name: 'brag-title', label: 'Title',
                      value: e.title, required: true,
                      placeholder: 'e.g. Closed Q3 books ahead of schedule — or Shipped incident-detection MVP' })}
        ${formField({ type: 'textarea', name: 'brag-body', label: 'Description',
                      value: e.body, rows: 6,
                      placeholder: 'Describe what you did and why it mattered: your role/contributions, the impact (numbers if you have them — dollars saved, % improved, users reached — or key non-numeric wins like passing an audit), and how it turned out after launch. What would you tell a friend to convince them to join your team? Any recent praise worth capturing?' })}
        ${formField({ type: 'text', name: 'brag-impact', label: 'Impact (optional)',
                      value: e.impact || '',
                      placeholder: 'e.g. Cut close time 9 → 6 days · Reduced 30-day churn by 18%',
                      hint: 'The quantitative outcome, if any. Stored separately so the AI can surface metrics when tailoring.' })}
        <div class="grid gap-4 sm:grid-cols-2">
          ${formField({ type: 'select', name: 'brag-company', label: 'Company (optional)',
                        options: [
                          { value: '', label: '— none —', selected: !e.company_id },
                          ...companies.map(c => ({
                            value: String(c.id),
                            label: c.official_name,
                            selected: c.id === e.company_id,
                          })),
                        ] })}
          ${formField({ type: 'number', name: 'brag-date', label: 'Year (optional)',
                        value: (e.entry_date || '').slice(0, 4),
                        placeholder: CURRENT_YEAR,
                        min: '1970',
                        step: '1' })}
        </div>
        <div class="grid gap-2">
          <div class="flex items-baseline justify-between gap-3">
            <label class="${CLS.label}" for="brag-tag-input">Tags</label>
            ${button({ id: 'btn-generate-brag-tags', variant: 'secondaryCompact', icon: 'sparkles', label: 'Generate tags' })}
          </div>
          <div id="brag-tags-list"></div>
          <div class="flex items-center gap-2">
            <input id="brag-tag-input" type="text" placeholder="Type a tag and press Enter" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
            ${button({ id: 'btn-add-brag-tag', variant: 'secondaryCompact', icon: 'plus', label: 'Add' })}
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
      : '<p class="text-sm text-slate-400">No tags yet. Generate from the brag body or add your own.</p>';
    listEl.querySelectorAll('.js-brag-tag-delete').forEach(btn => btn.addEventListener('click', () => {
      const tag = normalizeTag(btn.dataset.tag);
      state.bragDraftTags = state.bragDraftTags.filter(t => normalizeTag(t) !== tag);
      renderTagList();
    }));
    const stamp = state.bragPendingTagsGeneratedAt || e.tags_generated_at;
    const stampEl = document.getElementById('brag-tags-updated');
    stampEl.textContent = stamp ? `Tag suggestions updated ${formatDate(stamp)}` : '';
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
      setInlineError('brag-error', '');
      const body = document.getElementById('brag-body').value;
      if (!body.trim()) {
        setInlineError('brag-error', 'Description is required to generate tags');
        return;
      }
      const out = await generateBragTags({ body });
      state.bragDraftTags = Array.isArray(out?.tags) ? out.tags : [];
      state.bragPendingTagsGeneratedAt = new Date().toISOString();
      renderTagList();
    } catch (err) {
      setInlineError('brag-error', err.message || String(err));
    }
  });
  renderTagList();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = document.getElementById('brag-title').value.trim();
    if (!title) { setInlineError('brag-error', 'Title is required'); return; }
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
        toast('Brag entry saved', 'ok');
      } else {
        const id = await createBragEntry(data);
        toast(`Created brag entry #${id}`, 'ok');
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
