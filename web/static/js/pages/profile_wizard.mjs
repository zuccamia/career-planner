// Profile setup wizard — 9-step guided first pass over the profile_overview
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
//   skillsEditorHtml(opts)  — reused from profile.mjs (skills step 8)
//   wireSkillsEditor(...)   — reused from profile.mjs (skills step 8)
//   toolsListHtml(tools)    — reused from profile.mjs (tools step 9)

import { CLS } from '../ui/classes.mjs';
import { LOOKING_FOR_VALUES } from '../db/schema.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { icon } from '../ui/icons.mjs';
import { button, subheadTitle, inlineError, setInlineError } from '../ui/components.mjs';
import { t } from '../i18n.mjs';
import {
  updateOverview, markOnboarded, hydrateCareerSparks, hydrateTools, hydrateLocations,
  setWizardProgress, clearWizardProgress,
} from '../entities/profile-overview.mjs';
import { listSparks, createSpark, deleteSpark } from '../entities/career-sparks.mjs';
import { wireChipEditor } from '../ui/chip_editor.mjs';
import { workplaceTypeCardsHtml, wireWorkplaceTypeCards } from '../ui/workplace_type_cards.mjs';
import { removablePill } from '../ui/components.mjs';

export const WIZARD_STEPS = 9;

// Steps grouped into three phases: "You" (1–2) collects identity, "Direction"
// (3–7) captures aim + search constraints + values + workplace type, "Craft"
// (8–9) covers skills and tools. Progress bar segments and phase label read
// from this table.
const WIZARD_PHASES = [
  { key: 'you',       labelKey: 'profile.wizard.phase.you',       steps: [1, 2] },
  { key: 'direction', labelKey: 'profile.wizard.phase.direction', steps: [3, 4, 5, 6, 7] },
  { key: 'craft',     labelKey: 'profile.wizard.phase.craft',     steps: [8, 9] },
];

// Steps where clicking Skip exits the wizard entirely (mark onboarded, hand
// back to the flat form). Rationale: identity/pitch/direction are the
// wizard's opinionated core. If the user skips any of them they don't want
// the guided flow — dropping them into the flat form respects that. Later
// steps are optional refinements; Skip on those just advances.
const WIZARD_EXIT_ON_SKIP = new Set([1, 2, 3]);

const stepPhase = (step) => WIZARD_PHASES.find(p => p.steps.includes(step)) || WIZARD_PHASES[0];

// Swap the active/inactive palette on a choice-card button. Kept small so
// callers that already own aria-pressed logic (e.g. multi-select chips)
// don't need to duplicate the classList string-splitting.
const swapChoiceCardPalette = (btn, on) => {
  const [addPalette, removePalette] = on
    ? [CLS.choiceCardActive, CLS.choiceCardInactive]
    : [CLS.choiceCardInactive, CLS.choiceCardActive];
  btn.classList.remove(...removePalette.split(' '));
  btn.classList.add(...addPalette.split(' '));
};

const persistProgress = (state) => setWizardProgress({
  step: state.wizardStep,
  name: state.wizardOverview.name,
  headline: state.wizardOverview.headline,
  summary: state.wizardOverview.summary,
  looking_for: state.wizardOverview.looking_for,
  locations: state.wizardOverview.locations,
  workplace_type: state.wizardOverview.workplace_type,
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
  else if (step === 4) body = lookingForStep(state);
  else if (step === 5) body = locationsStep(ctx);
  else if (step === 6) body = await valuesStep(state);
  else if (step === 7) body = workplaceTypeStep(ctx);
  else if (step === 8) body = skillsStep(ctx);
  else if (step === 9) body = toolsStep(ctx);

  // Skip on the first 3 steps exits the wizard (see WIZARD_EXIT_ON_SKIP);
  // label reflects that. Later-step skips just advance.
  const skipLabelKey = WIZARD_EXIT_ON_SKIP.has(step)
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
          ${button({ id: 'btn-wizard-back', variant: 'icon', icon: 'arrowLeft', iconOnly: true, ariaLabel: t('profile.wizard.action.back'), disabled: step === 1 })}
        </div>
        <div class="flex gap-2">
          ${button({ id: 'btn-wizard-skip', variant: 'linkMuted', label: t(skipLabelKey) })}
          ${step < WIZARD_STEPS
            ? button({ id: 'btn-wizard-next', variant: 'primaryCompact', label: t('profile.wizard.action.next') })
            : button({ id: 'btn-wizard-done', variant: 'primaryCompact', icon: 'check', label: t('profile.wizard.action.finish') })}
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

const stepShell = ({ heading, help, controls, spacing = 'space-y-3' }) => `
  <div class="${spacing}">
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
  controls: textInput({ state, field: 'headline', placeholder: t('profile.wizard.step.pitch.placeholder') }),
});

const directionStep = (state) => stepShell({
  heading: t('profile.wizard.step.direction.label'),
  help: t('profile.wizard.step.direction.help'),
  controls: textInput({ state, field: 'summary', placeholder: t('profile.wizard.step.direction.placeholder'), multiline: true }),
});

const lookingForStep = (state) => stepShell({
  heading: t('profile.field.looking_for.label'),
  help: t('profile.field.looking_for.help'),
  controls: `
    <select id="wiz-looking-for" class="${CLS.select}">
      ${LOOKING_FOR_VALUES.map(v => `<option value="${v}" ${v === (state.wizardOverview.looking_for || 'open') ? 'selected' : ''}>${t(`profile.field.looking_for.option.${v}`)}</option>`).join('')}
    </select>
  `,
});

const locationPillHtml = (name) => removablePill({
  label: name,
  color: 'slate',
  classes: 'gap-1.5',
  dataset: { location: name },
  dismissClass: 'js-location-delete',
  dismissLabel: t('common.action.delete'),
});

const locationsListHtml = (locations) => locations.length
  ? `<div class="${CLS.chipRow}">${locations.map(locationPillHtml).join('')}</div>`
  : `<p class="${CLS.helpText}">${escapeHtml(t('profile.field.locations.empty'))}</p>`;

const locationsStep = ({ state }) => stepShell({
  spacing: 'space-y-4',
  heading: t('profile.field.locations.label'),
  help: t('profile.field.locations.help'),
  controls: `
    <div id="wiz-locations-list">${locationsListHtml(state.wizardOverview.locations || [])}</div>
    <div class="${CLS.responsiveRow}">
      <input id="wiz-locations-input" type="text" placeholder="${t('profile.field.locations.placeholder')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
      ${button({ id: 'btn-wiz-location-add', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
    </div>
  `,
});

// Values step — up-to-3 multi-select. Each pick becomes a P1 career spark
// on Next. Presets come from i18n; the "add your own" input lets the user
// append custom values before committing.
const valuesPresets = () => [1, 2, 3, 4, 5, 6].map(n => t(`profile.wizard.step.values.preset.${n}`));

const valuesStep = async (state) => {
  const presets = valuesPresets();
  const selected = new Set((state.wizardValuesCustom || []).map(s => s.body.toLowerCase()));
  const existingSparks = state.wizardValuesSparkIds.length ? await listSparks() : [];
  const existingBodies = [];
  existingSparks.forEach(s => {
    const spark = hydrateCareerSparks([s])[0];
    if (!spark?.body || !state.wizardValuesSparkIds.includes(s.id)) return;
    existingBodies.push(spark.body);
    selected.add(spark.body.toLowerCase());
  });
  const chips = [...presets, ...existingBodies, ...(state.wizardValuesCustom || []).map(s => s.body)]
    .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
  const existingLower = new Set(existingBodies.map(b => b.toLowerCase()));
  const chipHtml = chips.map(label => {
    const isOn = selected.has(label.toLowerCase());
    const isExisting = existingLower.has(label.toLowerCase());
    const palette = isOn ? CLS.choiceCardActive : CLS.choiceCardInactive;
    const existingAttr = isExisting ? ' data-existing="1"' : '';
    return `<button type="button" class="js-value-chip ${CLS.choiceCardBase} ${palette}" data-value="${escapeHtml(label)}"${existingAttr} aria-pressed="${isOn}"><span class="${CLS.choiceCardTitle}">${escapeHtml(label)}</span></button>`;
  }).join('');
  return stepShell({
    spacing: 'space-y-4',
    heading: t('profile.wizard.step.values.label'),
    help: t('profile.wizard.step.values.help'),
    controls: `
      <div id="wiz-values-chips" class="grid grid-cols-1 gap-2 sm:grid-cols-2">${chipHtml}</div>
      <p id="wiz-values-max" class="${CLS.helpText} hidden">${escapeHtml(t('profile.wizard.step.values.max_reached'))}</p>
      <div class="${CLS.responsiveRow}">
        <input id="wiz-values-custom-input" type="text" placeholder="${t('profile.wizard.step.values.add_own')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
        ${button({ id: 'btn-wiz-values-add', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
      </div>
    `,
  });
};

const workplaceTypeStep = ({ state }) => stepShell({
  spacing: 'space-y-4',
  heading: t('profile.wizard.step.workplace_type.label'),
  help: t('profile.wizard.step.workplace_type.help'),
  controls: `
    <div id="wiz-workplace-type-cards" class="${CLS.choiceCardRow}">
      ${workplaceTypeCardsHtml(state.wizardOverview.workplace_type || '')}
    </div>
  `,
});

const skillsStep = ({ state, skillsEditorHtml }) => stepShell({
  spacing: 'space-y-4',
  heading: t('profile.wizard.step.skills.label'),
  help: t('profile.wizard.step.skills.help'),
  controls: skillsEditorHtml({ mountId: 'wiz-skills-editor', skills: state.wizardOverview.skills || [] }),
});

const toolsStep = ({ state, toolsListHtml }) => stepShell({
  spacing: 'space-y-4',
  heading: t('profile.wizard.step.tools.label'),
  help: t('profile.wizard.step.tools.help'),
  controls: `
    <div id="wiz-tools-list">${toolsListHtml(state.wizardOverview.tools || [])}</div>
    <div class="${CLS.responsiveRow}">
      <input id="wiz-tools-input" type="text" placeholder="${t('profile.wizard.step.tools.placeholder')}" class="${CLS.inputBase} flex-1 min-w-0" autocomplete="off" />
      ${button({ id: 'btn-wiz-tools-add', variant: 'secondaryCompact', icon: 'plus', label: t('common.action.add') })}
    </div>
  `,
});

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
  state.wizardOverview[field] = input.value;
  await updateOverview({ [field]: input.value });
};

const wireLookingForStep = (ctx) => {
  const { state } = ctx;
  document.getElementById('wiz-looking-for')?.addEventListener('change', async (ev) => {
    const val = ev.target.value;
    state.wizardOverview.looking_for = val;
    await updateOverview({ looking_for: val });
    await persistProgress(state);
  });
};

const wireLocationsStep = (ctx) => {
  const { state } = ctx;
  wireChipEditor({
    listEl: document.getElementById('wiz-locations-list'),
    inputEl: document.getElementById('wiz-locations-input'),
    addBtnEl: document.getElementById('btn-wiz-location-add'),
    initial: state.wizardOverview.locations || [],
    render: locationsListHtml,
    dismissSelector: '.js-location-delete',
    itemAttr: 'location',
    normalize: hydrateLocations,
    onChange: async (locations) => {
      state.wizardOverview.locations = locations;
      await updateOverview({ locations });
      await persistProgress(state);
    },
  });
};

// Commit step 6's selected values as P1 career sparks. Removes tracked
// sparks the user has since deselected; adds new ones. After commit, any
// newly-added chip is promoted into wizardValuesSparkIds, so
// wizardValuesCustom is drained.
const commitValuesSparks = async (state) => {
  const chipButtons = document.querySelectorAll('#wiz-values-chips .js-value-chip');
  const selected = [];
  chipButtons.forEach(btn => {
    if (btn.getAttribute('aria-pressed') === 'true') selected.push(btn.dataset.value);
  });
  const existing = state.wizardValuesSparkIds.length ? await listSparks() : [];
  const existingById = new Map(existing.map(s => [s.id, hydrateCareerSparks([s])[0]?.body || '']));
  const keepIds = [];
  for (const id of state.wizardValuesSparkIds) {
    const body = existingById.get(id);
    if (body == null) continue;
    if (selected.includes(body)) keepIds.push(id);
    else await deleteSpark(id);
  }
  const trackedBodies = new Set(keepIds.map(id => existingById.get(id)));
  for (const val of selected) {
    if (trackedBodies.has(val)) continue;
    const spark = hydrateCareerSparks([{ id: null, body: val, sort_order: 1 }])[0];
    if (!spark?.body) continue;
    const id = await createSpark(spark.body, spark.sort_order);
    keepIds.push(id);
  }
  state.wizardValuesSparkIds = keepIds;
  state.wizardValuesCustom = [];
};

const wireWizard = (ctx) => {
  const { state, mountEl } = ctx;
  const step = state.wizardStep;
  document.getElementById('wiz-input')?.focus();

  document.getElementById('wiz-input')?.addEventListener('input', async (ev) => {
    // Update state + Next/Skip button state SYNCHRONOUSLY on input so a
    // Update state SYNCHRONOUSLY so a fast follow-up click sees the fresh
    // value. DB writes are async and fire-and-forget after the UI mirror.
    const field = ev.target.dataset.field;
    if (field) state.wizardOverview[field] = ev.target.value;
    await captureTextField(state);
    await persistProgress(state);
  });

  // All nav handlers share the same "surface errors, don't stall" pattern:
  // an unhandled reject inside a click listener leaves the wizard frozen on
  // the current step with no visible feedback. Route errors to the inline
  // banner instead. We also disable every nav button for the duration of the
  // transition so a second click (real user or e2e test) can't race the
  // in-flight render and end up firing the previous step's handler against
  // the still-visible stale button.
  const navHandler = (fn) => async () => {
    const btns = ['btn-wizard-back', 'btn-wizard-skip', 'btn-wizard-next', 'btn-wizard-done']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    for (const b of btns) b.disabled = true;
    try { await fn(); }
    catch (err) {
      setInlineError('wizard-error', err.message || String(err));
      for (const b of btns) b.disabled = false;
    }
    // Success path: renderWizard replaced the button DOM with a fresh set,
    // so the just-disabled nodes are gone. No re-enable needed.
  };

  document.getElementById('btn-wizard-back')?.addEventListener('click', navHandler(async () => {
    if (step === 1) return;
    if (step === 6) await commitValuesSparks(state);
    await captureTextField(state);
    state.wizardStep = step - 1;
    await persistProgress(state);
    await renderWizard(ctx);
  }));

  document.getElementById('btn-wizard-skip')?.addEventListener('click', navHandler(async () => {
    await captureTextField(state);
    if (step === 6) await commitValuesSparks(state);
    // Skipping any of the first 3 steps signals the user doesn't want the
    // guided flow — exit to the flat form.
    if (WIZARD_EXIT_ON_SKIP.has(step)) {
      await clearWizardProgress();
      await markOnboarded();
      ctx.renderOverviewTab(ctx.mountEl);
      return;
    }
    if (step === WIZARD_STEPS) { renderReady(ctx); return; }
    state.wizardStep = Math.min(WIZARD_STEPS, step + 1);
    await persistProgress(state);
    await renderWizard(ctx);
  }));

  document.getElementById('btn-wizard-next')?.addEventListener('click', navHandler(async () => {
    await captureTextField(state);
    if (step === 6) await commitValuesSparks(state);
    state.wizardStep = step + 1;
    await persistProgress(state);
    await renderWizard(ctx);
  }));

  document.getElementById('btn-wizard-done')?.addEventListener('click', navHandler(async () => {
    await captureTextField(state);
    if (step === 6) await commitValuesSparks(state);
    renderReady(ctx);
  }));

  if (step === 4) wireLookingForStep(ctx);
  if (step === 5) wireLocationsStep(ctx);
  if (step === 6) wireValuesSparksStep(ctx);
  if (step === 7) wireWorkplaceTypeStep(ctx);
  if (step === 8) {
    ctx.wireSkillsEditor('wiz-skills-editor', state.wizardOverview.skills || [], async (skills) => {
      state.wizardOverview.skills = skills;
      await updateOverview({ skills });
      await persistProgress(state);
    });
  }
  if (step === 9) wireToolsStep(ctx);
};

const wireValuesSparksStep = (ctx) => {
  const { state } = ctx;
  const chipsMount = document.getElementById('wiz-values-chips');
  const maxNote = document.getElementById('wiz-values-max');
  // Cap counts only new picks — chips flagged data-existing="1" are
  // grandfathered from the max-3 rule so returning users with existing sparks
  // can still add more without deselecting the ones they already have.
  const newPickCount = () => chipsMount.querySelectorAll('[aria-pressed="true"]:not([data-existing="1"])').length;
  const updateMaxNote = () => {
    maxNote.classList.toggle('hidden', newPickCount() < 3);
  };
  const wireChips = () => {
    chipsMount.querySelectorAll('.js-value-chip').forEach(btn => {
      btn.addEventListener('click', async () => {
        const isOn = btn.getAttribute('aria-pressed') === 'true';
        const isExisting = btn.getAttribute('data-existing') === '1';
        if (!isOn && !isExisting && newPickCount() >= 3) { updateMaxNote(); return; }
        btn.setAttribute('aria-pressed', String(!isOn));
        swapChoiceCardPalette(btn, !isOn);
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
    const spark = hydrateCareerSparks([{ id: null, body: input.value, sort_order: 1 }])[0];
    if (!spark?.body) return;
    const existing = new Set(Array.from(chipsMount.querySelectorAll('.js-value-chip')).map(b => b.dataset.value));
    if (existing.has(spark.body)) { input.value = ''; return; }
    if (!state.wizardValuesCustom.some(s => s.body === spark.body)) state.wizardValuesCustom.push(spark);
    input.value = '';
    const autoSelect = newPickCount() < 3;
    chipsMount.insertAdjacentHTML('beforeend',
      `<button type="button" class="js-value-chip ${CLS.choiceCardBase} ${autoSelect ? CLS.choiceCardActive : CLS.choiceCardInactive}" data-value="${escapeHtml(spark.body)}" aria-pressed="${autoSelect}"><span class="${CLS.choiceCardTitle}">${escapeHtml(spark.body)}</span></button>`);
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

const wireWorkplaceTypeStep = ({ state }) => {
  wireWorkplaceTypeCards({
    mountEl: document.getElementById('wiz-workplace-type-cards'),
    currentValue: state.wizardOverview.workplace_type || '',
    onChange: async (workplace_type) => {
      state.wizardOverview.workplace_type = workplace_type;
      await updateOverview({ workplace_type });
      await persistProgress(state);
    },
  });
};

const wireToolsStep = (ctx) => {
  const { state, toolsListHtml } = ctx;
  wireChipEditor({
    listEl: document.getElementById('wiz-tools-list'),
    inputEl: document.getElementById('wiz-tools-input'),
    addBtnEl: document.getElementById('btn-wiz-tools-add'),
    initial: state.wizardOverview.tools || [],
    render: toolsListHtml,
    dismissSelector: '.js-tool-delete',
    itemAttr: 'tool',
    normalize: hydrateTools,
    onChange: async (tools) => {
      state.wizardOverview.tools = tools;
      await updateOverview({ tools });
      await persistProgress(state);
    },
  });
};
