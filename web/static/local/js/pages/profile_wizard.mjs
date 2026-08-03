// Profile setup wizard — 7-step guided first pass over the profile_overview
// fields plus career sparks + skills + tools. Rendered by profile.mjs when
// profile_overview.onboarded_at is NULL and all key fields are empty (or on
// demand from the "Redo intro" button). Consumers pass in a context object
// so the wizard can drive shared page state and DB helpers without
// duplicating imports here.
//
// Context shape (all required):
//   state           — profile.mjs page state (wizardStep, wizardOverview,
//                     wizardValuesSparkIds, wizardValuesCustom)
//   mountEl         — element the wizard replaces its innerHTML on (also
//                     used to hand back to renderOverviewTab on Finish)
//   renderOverviewTab(el)   — return to the flat form after Finish/Skip-all
//   skillsEditorHtml(opts)  — reused from profile.mjs (skills step 6)
//   wireSkillsEditor(...)   — reused from profile.mjs (skills step 6)
//   envCardsHtml(active)    — reused from profile.mjs (env step 5 + card row)
//   toolsListHtml(tools)    — reused from profile.mjs (tools step 7)

import { CLS } from '../ui/classes.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';
import { button, subheadTitle, inlineError, setInlineError } from '../ui/components.mjs';
import { t } from '../i18n.mjs';
import {
  updateOverview, markOnboarded,
  setWizardProgress, clearWizardProgress,
} from '../entities/profile-overview.mjs';
import { listSparks, createSpark, deleteSpark } from '../entities/career-sparks.mjs';

export const WIZARD_STEPS = 7;

// Steps grouped into three phases: "You" (1–2) collects identity, "Direction"
// (3–5) captures aim + values + environment, "Craft" (6–7) covers skills and
// tools. Progress bar segments and phase label read from this table.
const WIZARD_PHASES = [
  { key: 'you',       labelKey: 'profile.wizard.phase.you',       steps: [1, 2] },
  { key: 'direction', labelKey: 'profile.wizard.phase.direction', steps: [3, 4, 5] },
  { key: 'craft',     labelKey: 'profile.wizard.phase.craft',     steps: [6, 7] },
];

// Required-field policy per step. `null` = optional; any other value is the
// wizard-error i18n key surfaced when the user tries to advance without
// filling it in.
const WIZARD_REQUIREMENTS = {
  1: 'profile.wizard.error.name_required',
  2: null,
  3: 'profile.wizard.error.direction_required',
  4: null,
  5: null,
  6: 'profile.wizard.error.skills_required',
  7: null,
};

const stepPhase = (step) => WIZARD_PHASES.find(p => p.steps.includes(step)) || WIZARD_PHASES[0];

// True when the required answer for `step` is currently filled in.
const stepIsSatisfied = (state, step) => {
  const req = WIZARD_REQUIREMENTS[step];
  if (!req) return true;
  if (step === 1) return !!(state.wizardOverview.name || '').trim();
  if (step === 3) return !!(state.wizardOverview.direction || '').trim();
  if (step === 6) return (state.wizardOverview.skills || []).length > 0;
  return true;
};

const firstIncompleteRequiredStep = (state) => {
  for (let s = 1; s <= WIZARD_STEPS; s++) {
    if (WIZARD_REQUIREMENTS[s] && !stepIsSatisfied(state, s)) return s;
  }
  return null;
};

const persistProgress = (state) => setWizardProgress({
  step: state.wizardStep,
  name: state.wizardOverview.name,
  pitch: state.wizardOverview.pitch,
  direction: state.wizardOverview.direction,
  environment: state.wizardOverview.environment,
  tools: state.wizardOverview.tools,
  valuesSparkIds: state.wizardValuesSparkIds,
  valuesCustom: state.wizardValuesCustom,
});

// ---------- shell ----------

const phaseBarHtml = (step) => {
  const parts = WIZARD_PHASES.map(phase => {
    const completedInPhase = phase.steps.filter(s => s < step).length;
    const isCurrent = phase.steps.includes(step);
    let pct;
    if (isCurrent) {
      pct = (completedInPhase / phase.steps.length) * 100;
    } else {
      pct = phase.steps[phase.steps.length - 1] < step ? 100 : 0;
    }
    return `<span class="${CLS.wizardPhaseSegment}"><span class="${CLS.wizardPhaseFill}" style="width:${pct}%"></span></span>`;
  }).join('');
  return `<div class="${CLS.wizardPhaseBar}" aria-hidden="true">${parts}</div>`;
};

export const renderWizard = async (ctx) => {
  const { state, mountEl } = ctx;
  const step = state.wizardStep;
  const phase = stepPhase(step);

  let body = '';
  if (step === 1)      body = nameStep(state);
  else if (step === 2) body = pitchStep(state);
  else if (step === 3) body = directionStep(state);
  else if (step === 4) body = await valuesStep(state);
  else if (step === 5) body = envStep(ctx);
  else if (step === 6) body = skillsStep(ctx);
  else if (step === 7) body = toolsStep(ctx);

  const required = !!WIZARD_REQUIREMENTS[step];
  const satisfied = stepIsSatisfied(state, step);
  const skipLabelKey = (step === 1 && !satisfied)
    ? 'profile.wizard.action.skip_all'
    : 'profile.wizard.action.skip_this';

  mountEl.innerHTML = `
    <div class="${CLS.card} max-w-2xl mx-auto">
      <div class="flex items-center justify-between">
        <p class="${CLS.eyebrowFaint}">${t('profile.wizard.progress', { step, total: WIZARD_STEPS })}</p>
        <p class="${CLS.wizardPhaseLabel}">${t(phase.labelKey)}</p>
      </div>
      ${phaseBarHtml(step)}
      ${inlineError({ id: 'wizard-error' })}
      <div class="pt-2">${body}</div>
      <div class="flex items-center justify-between pt-4">
        <div>
          ${button({ id: 'btn-wizard-back', variant: 'secondaryCompact', label: t('profile.wizard.action.back'), disabled: step === 1 })}
        </div>
        <div class="flex gap-2">
          ${button({ id: 'btn-wizard-skip', variant: 'linkMuted', label: t(skipLabelKey) })}
          ${step < WIZARD_STEPS
            ? button({ id: 'btn-wizard-next', variant: 'primaryCompact', label: t('profile.wizard.action.next'), disabled: required && !satisfied })
            : button({ id: 'btn-wizard-done', variant: 'primaryCompact', icon: 'check', label: t('profile.wizard.action.finish'), disabled: required && !satisfied })}
        </div>
      </div>
    </div>
  `;
  wireWizard(ctx);
};

// ---------- individual steps ----------

const textInput = ({ state, field, placeholder, multiline = false }) => {
  const val = state.wizardOverview[field] || '';
  return multiline
    ? `<textarea id="wiz-input" data-field="${field}" rows="6" placeholder="${escapeHtml(placeholder)}" class="${CLS.textarea}">${escapeHtml(val)}</textarea>`
    : `<input id="wiz-input" data-field="${field}" type="text" value="${escapeHtml(val)}" placeholder="${escapeHtml(placeholder)}" class="${CLS.input}" />`;
};

const stepShell = ({ heading, help, controls }) => `
  <div class="space-y-3">
    <div>
      ${subheadTitle(heading)}
      <p class="mt-1 ${CLS.helpText}">${escapeHtml(help)}</p>
    </div>
    ${controls}
  </div>
`;

const nameStep = (state) => stepShell({
  heading: t('profile.wizard.name.label'),
  help: t('profile.field.name.hint'),
  controls: textInput({ state, field: 'name', placeholder: t('profile.field.name.placeholder') }),
});

const pitchStep = (state) => stepShell({
  heading: t('profile.wizard.step.pitch.label'),
  help: t('profile.wizard.step.pitch.help'),
  controls: textInput({ state, field: 'pitch', placeholder: t('profile.wizard.step.pitch.placeholder') }),
});

const directionStep = (state) => stepShell({
  heading: t('profile.wizard.step.direction.label'),
  help: t('profile.wizard.step.direction.help'),
  controls: textInput({ state, field: 'direction', placeholder: t('profile.wizard.step.direction.placeholder'), multiline: true }),
});

// Values step — up-to-3 multi-select. Each pick becomes a P1 career spark
// on Next. Presets come from i18n; the "add your own" input lets the user
// append custom values before committing.
const valuesPresets = () => [1, 2, 3, 4, 5, 6].map(n => t(`profile.wizard.step.values.preset.${n}`));

const valuesStep = async (state) => {
  const presets = valuesPresets();
  const selected = new Set([...(state.wizardValuesCustom || [])]);
  const existingSparks = state.wizardValuesSparkIds.length ? await listSparks() : [];
  existingSparks.forEach(s => {
    if (state.wizardValuesSparkIds.includes(s.id)) selected.add(s.body);
  });
  const chips = [...presets, ...(state.wizardValuesCustom || [])]
    .filter((v, i, arr) => arr.indexOf(v) === i);
  const chipHtml = chips.map(label => {
    const isOn = selected.has(label);
    const palette = isOn ? CLS.choiceCardActive : CLS.choiceCardInactive;
    return `<button type="button" class="js-value-chip ${CLS.choiceCardBase} ${palette}" data-value="${escapeHtml(label)}" aria-pressed="${isOn}"><span class="${CLS.choiceCardTitle}">${escapeHtml(label)}</span></button>`;
  }).join('');
  return `
    <div class="space-y-4">
      <div>
        ${subheadTitle(t('profile.wizard.step.values.label'))}
        <p class="mt-1 ${CLS.helpText}">${escapeHtml(t('profile.wizard.step.values.help'))}</p>
      </div>
      <div id="wiz-values-chips" class="grid grid-cols-1 gap-2 sm:grid-cols-2">${chipHtml}</div>
      <p id="wiz-values-max" class="${CLS.helpText} hidden">${escapeHtml(t('profile.wizard.step.values.max_reached'))}</p>
      <div class="flex items-center gap-2">
        <input id="wiz-values-custom-input" type="text" placeholder="${t('profile.wizard.step.values.add_own')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
        ${button({ id: 'btn-wiz-values-add', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
      </div>
    </div>
  `;
};

const envStep = ({ state, envCardsHtml }) => `
  <div class="space-y-4">
    <div>
      ${subheadTitle(t('profile.wizard.step.env.label'))}
      <p class="mt-1 ${CLS.helpText}">${escapeHtml(t('profile.wizard.step.env.help'))}</p>
    </div>
    <div id="wiz-env-cards" class="${CLS.choiceCardRow}">
      ${envCardsHtml(state.wizardOverview.environment || '')}
    </div>
  </div>
`;

const skillsStep = ({ state, skillsEditorHtml }) => `
  <div class="space-y-4">
    <div>
      ${subheadTitle(t('profile.wizard.step.skills.label'))}
      <p class="mt-1 ${CLS.helpText}">${escapeHtml(t('profile.wizard.step.skills.help'))}</p>
    </div>
    ${skillsEditorHtml({ mountId: 'wiz-skills-editor', skills: state.wizardOverview.skills || [] })}
  </div>
`;

const toolsStep = ({ state, toolsListHtml }) => `
  <div class="space-y-4">
    <div>
      ${subheadTitle(t('profile.wizard.step.tools.label'))}
      <p class="mt-1 ${CLS.helpText}">${escapeHtml(t('profile.wizard.step.tools.help'))}</p>
    </div>
    <div id="wiz-tools-list">${toolsListHtml(state.wizardOverview.tools || [])}</div>
    <div class="flex items-center gap-2">
      <input id="wiz-tools-input" type="text" placeholder="${t('profile.wizard.step.tools.placeholder')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
      ${button({ id: 'btn-wiz-tools-add', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
    </div>
  </div>
`;

// ---------- Profile-ready screen ----------

const renderReady = (ctx) => {
  const { mountEl, renderOverviewTab } = ctx;
  mountEl.innerHTML = `
    <div class="${CLS.card} ${CLS.readyCard}">
      <span class="${CLS.readyIconCircle}">${icon('check', 5, { strokeWidth: 2 })}</span>
      <h2 class="${CLS.readyTitle}">${escapeHtml(t('profile.wizard.ready.title'))}</h2>
      <p class="${CLS.readyBody}">${escapeHtml(t('profile.wizard.ready.body'))}</p>
      <div class="pt-2">
        ${button({ id: 'btn-wizard-ready', variant: 'primary', label: t('profile.wizard.ready.action') })}
      </div>
    </div>
  `;
  document.getElementById('btn-wizard-ready').addEventListener('click', async () => {
    await clearWizardProgress();
    await markOnboarded();
    renderOverviewTab(mountEl);
  });
};

// ---------- wiring ----------

const captureTextField = async (state) => {
  const input = document.getElementById('wiz-input');
  if (!input) return;
  const field = input.dataset.field;
  if (!field) return;
  const val = input.value;
  state.wizardOverview[field] = val;
  const col = field === 'pitch' ? 'headline'
            : field === 'direction' ? 'summary'
            : field;
  await updateOverview({ [col]: val });
};

// Commit step 4's selected values as P1 career sparks. Removes tracked
// sparks the user has since deselected; adds new ones.
const commitValuesSparks = async (state) => {
  const presets = valuesPresets();
  const chipButtons = document.querySelectorAll('#wiz-values-chips .js-value-chip');
  if (!chipButtons.length) return;
  const selected = [];
  chipButtons.forEach(btn => {
    if (btn.getAttribute('aria-pressed') === 'true') selected.push(btn.dataset.value);
  });
  const existing = state.wizardValuesSparkIds.length ? await listSparks() : [];
  const existingById = new Map(existing.map(s => [s.id, s]));
  const keepIds = [];
  for (const id of state.wizardValuesSparkIds) {
    const s = existingById.get(id);
    if (s && selected.includes(s.body)) keepIds.push(id);
    else if (s) await deleteSpark(id);
  }
  const trackedBodies = new Set(keepIds.map(id => existingById.get(id).body));
  for (const val of selected) {
    if (trackedBodies.has(val)) continue;
    const id = await createSpark(val, 1);
    keepIds.push(id);
  }
  state.wizardValuesSparkIds = keepIds;
  // Custom entries beyond the preset list are remembered so they re-render
  // when the user comes back to step 4.
  state.wizardValuesCustom = selected.filter(v => !presets.includes(v));
};

const wireWizard = (ctx) => {
  const { state, mountEl } = ctx;
  const step = state.wizardStep;
  document.getElementById('wiz-input')?.focus();

  document.getElementById('wiz-input')?.addEventListener('input', async () => {
    await captureTextField(state);
    await persistProgress(state);
    const nextBtn = document.getElementById('btn-wizard-next') || document.getElementById('btn-wizard-done');
    if (nextBtn) {
      const req = !!WIZARD_REQUIREMENTS[step];
      nextBtn.disabled = req && !stepIsSatisfied(state, step);
    }
    const skipBtn = document.getElementById('btn-wizard-skip');
    if (skipBtn && step === 1) {
      skipBtn.querySelector('span').textContent = t(stepIsSatisfied(state, 1)
        ? 'profile.wizard.action.skip_this'
        : 'profile.wizard.action.skip_all');
    }
  });

  document.getElementById('btn-wizard-back')?.addEventListener('click', async () => {
    if (step === 1) return;
    if (step === 4) await commitValuesSparks(state);
    await captureTextField(state);
    state.wizardStep = step - 1;
    await persistProgress(state);
    renderWizard(ctx);
  });

  document.getElementById('btn-wizard-skip')?.addEventListener('click', async () => {
    await captureTextField(state);
    if (step === 4) await commitValuesSparks(state);
    // Skip-all: on step 1 with the required name still empty, the button
    // label reads "Skip setup" — treat that as bailing out of the wizard
    // entirely rather than looping back to the same step.
    if (step === 1 && !stepIsSatisfied(state, 1)) {
      await clearWizardProgress();
      await markOnboarded();
      ctx.renderOverviewTab(ctx.mountEl);
      return;
    }
    const required = !!WIZARD_REQUIREMENTS[step];
    if (required) {
      const target = firstIncompleteRequiredStep(state);
      if (target == null) { renderReady(ctx); return; }
      state.wizardStep = target;
      await persistProgress(state);
      renderWizard(ctx);
      return;
    }
    if (step === WIZARD_STEPS) { renderReady(ctx); return; }
    state.wizardStep = Math.min(WIZARD_STEPS, step + 1);
    await persistProgress(state);
    renderWizard(ctx);
  });

  document.getElementById('btn-wizard-next')?.addEventListener('click', async () => {
    try {
      await captureTextField(state);
      if (step === 4) await commitValuesSparks(state);
      if (WIZARD_REQUIREMENTS[step] && !stepIsSatisfied(state, step)) {
        setInlineError('wizard-error', t(WIZARD_REQUIREMENTS[step]));
        return;
      }
      state.wizardStep = step + 1;
      await persistProgress(state);
      renderWizard(ctx);
    } catch (err) {
      setInlineError('wizard-error', err.message || String(err));
    }
  });

  document.getElementById('btn-wizard-done')?.addEventListener('click', async () => {
    await captureTextField(state);
    if (step === 4) await commitValuesSparks(state);
    const target = firstIncompleteRequiredStep(state);
    if (target != null) {
      state.wizardStep = target;
      await persistProgress(state);
      renderWizard(ctx);
      return;
    }
    renderReady(ctx);
  });

  if (step === 4) wireValuesStep(ctx);
  if (step === 5) wireEnvStep(ctx);
  if (step === 6) {
    ctx.wireSkillsEditor('wiz-skills-editor', state.wizardOverview.skills || [], async (skills) => {
      state.wizardOverview.skills = skills;
      await updateOverview({ skills });
      await persistProgress(state);
      const nextBtn = document.getElementById('btn-wizard-next') || document.getElementById('btn-wizard-done');
      if (nextBtn) nextBtn.disabled = !stepIsSatisfied(state, 6);
    });
  }
  if (step === 7) wireToolsStep(ctx);
};

const wireValuesStep = (ctx) => {
  const { state } = ctx;
  const chipsMount = document.getElementById('wiz-values-chips');
  const maxNote = document.getElementById('wiz-values-max');
  const updateMaxNote = () => {
    const count = chipsMount.querySelectorAll('[aria-pressed="true"]').length;
    maxNote.classList.toggle('hidden', count < 3);
  };
  const wireChips = () => {
    chipsMount.querySelectorAll('.js-value-chip').forEach(btn => {
      btn.addEventListener('click', async () => {
        const isOn = btn.getAttribute('aria-pressed') === 'true';
        if (!isOn) {
          const count = chipsMount.querySelectorAll('[aria-pressed="true"]').length;
          if (count >= 3) { updateMaxNote(); return; }
        }
        btn.setAttribute('aria-pressed', String(!isOn));
        if (!isOn) {
          btn.classList.remove(...CLS.choiceCardInactive.split(' '));
          btn.classList.add(...CLS.choiceCardActive.split(' '));
        } else {
          btn.classList.remove(...CLS.choiceCardActive.split(' '));
          btn.classList.add(...CLS.choiceCardInactive.split(' '));
        }
        updateMaxNote();
        await persistProgress(state);
      });
    });
  };
  wireChips();
  updateMaxNote();

  const input = document.getElementById('wiz-values-custom-input');
  const addBtn = document.getElementById('btn-wiz-values-add');
  const addCustom = async () => {
    const val = (input.value || '').trim();
    if (!val) return;
    const existing = new Set(Array.from(chipsMount.querySelectorAll('.js-value-chip')).map(b => b.dataset.value));
    if (existing.has(val)) { input.value = ''; return; }
    if (!state.wizardValuesCustom.includes(val)) state.wizardValuesCustom.push(val);
    input.value = '';
    const selectedNow = chipsMount.querySelectorAll('[aria-pressed="true"]').length;
    const autoSelect = selectedNow < 3;
    chipsMount.insertAdjacentHTML('beforeend',
      `<button type="button" class="js-value-chip ${CLS.choiceCardBase} ${autoSelect ? CLS.choiceCardActive : CLS.choiceCardInactive}" data-value="${escapeHtml(val)}" aria-pressed="${autoSelect}"><span class="${CLS.choiceCardTitle}">${escapeHtml(val)}</span></button>`);
    wireChips();
    updateMaxNote();
    await persistProgress(state);
    input.focus();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addCustom(); }
  });
  addBtn.addEventListener('click', addCustom);
};

const wireEnvStep = (ctx) => {
  const { state, envCardsHtml } = ctx;
  const mount = document.getElementById('wiz-env-cards');
  const rerender = (value) => {
    mount.innerHTML = envCardsHtml(value);
    wireChoices();
  };
  const wireChoices = () => {
    mount.querySelectorAll('.js-env-choice').forEach(btn => {
      btn.addEventListener('click', async () => {
        const current = state.wizardOverview.environment || '';
        const clicked = btn.dataset.env;
        const next = current === clicked ? '' : clicked;
        state.wizardOverview.environment = next;
        await updateOverview({ environment: next });
        await persistProgress(state);
        rerender(next);
      });
    });
  };
  wireChoices();
};

const wireToolsStep = (ctx) => {
  const { state, toolsListHtml } = ctx;
  const listEl = document.getElementById('wiz-tools-list');
  const rerender = () => {
    listEl.innerHTML = toolsListHtml(state.wizardOverview.tools || []);
    listEl.querySelectorAll('.js-tool-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.tool;
        state.wizardOverview.tools = (state.wizardOverview.tools || []).filter(x => x !== name);
        await updateOverview({ tools: state.wizardOverview.tools });
        await persistProgress(state);
        rerender();
      });
    });
  };
  const input = document.getElementById('wiz-tools-input');
  const addBtn = document.getElementById('btn-wiz-tools-add');
  const addTool = async () => {
    const val = (input.value || '').trim();
    if (!val) return;
    const tools = state.wizardOverview.tools || [];
    if (!tools.includes(val)) tools.push(val);
    state.wizardOverview.tools = tools;
    input.value = '';
    await updateOverview({ tools });
    await persistProgress(state);
    rerender();
    input.focus();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addTool(); }
  });
  addBtn.addEventListener('click', addTool);
  rerender();
};
