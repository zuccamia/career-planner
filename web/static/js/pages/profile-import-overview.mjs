// Profile-overview extraction flow for the résumé import view. Fields the
// user already filled in stay unchecked by default (safety-by-default);
// skills and tools merge with the existing set instead of replacing it.

import { escapeHtml } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { button, emptyState, helpText, inlineError, removablePill, setInlineError, subheadTitle } from '../ui/components.mjs';
import { t, currentLocale } from '../i18n.mjs';
import { toast } from '../ui/toast.mjs';
import { extractOverviewFromResume } from '../rpc.mjs';
import { getOverview, updateOverview } from '../entities/profile-overview.mjs';

// Working copy during review. Mutable so pill-remove handlers can splice
// out skills/tools without rebuilding the whole review section. Reset per
// extraction run.
let overviewState = null;
// The profile row as it looked when the review UI was rendered — used at
// apply time to merge (not replace) arrays.
let currentOverview = null;

// mergeUnique appends `incoming` items onto `existing` skipping any whose
// key already appears in existing. `keyOf` returns the dedup key per item.
const mergeUnique = (existing, incoming, keyOf) => {
  const seen = new Set((existing || []).map(keyOf));
  const out = [...(existing || [])];
  for (const item of incoming || []) {
    const k = keyOf(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
};

const setOverviewStatus = (visible) => {
  const el = document.getElementById('ri-overview-status');
  if (el) el.classList.toggle('hidden', !visible);
};
const setOverviewError = (msg) => setInlineError('ri-overview-error', msg);

const skillPill = (s, i) => {
  const suffix = [];
  if (s.years != null) suffix.push(`${s.years}y`);
  if (s.level) suffix.push(s.level);
  const bodyHtml = `${escapeHtml(s.name)}${suffix.length ? ` <span class="opacity-70">· ${escapeHtml(suffix.join(' · '))}</span>` : ''}`;
  return removablePill({
    bodyHtml, color: 'slate', classes: 'gap-1.5',
    dataset: { 'ov-skill-index': String(i) },
    dismissClass: 'js-ov-remove-skill',
    dismissLabel: `Remove skill ${s.name}`,
  });
};

const toolPill = (name, i) => removablePill({
  bodyHtml: escapeHtml(name), color: 'slate',
  dataset: { 'ov-tool-index': String(i) },
  dismissClass: 'js-ov-remove-tool',
  dismissLabel: `Remove tool ${name}`,
});

const renderOverviewPills = () => {
  const skillsEl = document.getElementById('ri-ov-skills');
  const toolsEl = document.getElementById('ri-ov-tools');
  if (skillsEl) skillsEl.innerHTML = overviewState.skills.map(skillPill).join('');
  if (toolsEl) toolsEl.innerHTML = overviewState.tools.map(toolPill).join('');
  document.querySelectorAll('.js-ov-remove-skill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.closest('[data-ov-skill-index]')?.dataset.ovSkillIndex);
      if (Number.isFinite(idx)) {
        overviewState.skills.splice(idx, 1);
        renderOverviewPills();
      }
    });
  });
  document.querySelectorAll('.js-ov-remove-tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.closest('[data-ov-tool-index]')?.dataset.ovToolIndex);
      if (Number.isFinite(idx)) {
        overviewState.tools.splice(idx, 1);
        renderOverviewPills();
      }
    });
  });
};

const overviewFieldRow = ({ key, label, checked, currentValue, control }) => `
  <div class="space-y-1" data-ov-row="${key}">
    <label class="${CLS.inlineRow}">
      <input type="checkbox" data-ov-select="${key}"${checked ? ' checked' : ''} class="${CLS.checkbox}">
      <span class="${CLS.label}">${escapeHtml(label)}</span>
    </label>
    ${control}
    ${currentValue ? `<p class="${CLS.metaText}">${escapeHtml(t('profile_import.overview.field.current'))}: ${escapeHtml(currentValue)}</p>` : ''}
  </div>`;

const renderOverviewReview = (extracted, current, onExit) => {
  const el = document.getElementById('ri-overview-review');
  if (!el) return;
  const anyField = extracted.name || extracted.headline || extracted.summary || extracted.environment
    || (extracted.skills && extracted.skills.length) || (extracted.tools && extracted.tools.length);
  if (!anyField) {
    el.innerHTML = emptyState({ message: t('profile_import.overview.empty') });
    el.classList.remove('hidden');
    return;
  }
  overviewState = {
    name: extracted.name || '',
    headline: extracted.headline || '',
    summary: extracted.summary || '',
    environment: extracted.environment || '',
    skills: [...(extracted.skills || [])],
    tools: [...(extracted.tools || [])],
  };
  currentOverview = current || {};
  // Scalars default to unchecked when current already has a value — the user
  // must consciously opt in to overwrite. Arrays default checked because
  // apply merges them with existing skills/tools instead of replacing.
  const inputRow = (key, labelKey, value, currentValue) => overviewFieldRow({
    key, label: t(labelKey), checked: !!value && !(currentValue || '').trim(), currentValue,
    control: `<input type="text" data-ov-field="${key}" value="${escapeHtml(value)}" class="${CLS.input}">`,
  });
  const textareaRow = (key, labelKey, value, currentValue) => overviewFieldRow({
    key, label: t(labelKey), checked: !!value && !(currentValue || '').trim(), currentValue,
    control: `<textarea data-ov-field="${key}" spellcheck="true" class="${CLS.textarea} min-h-[6rem]">${escapeHtml(value)}</textarea>`,
  });
  const skillsRow = overviewFieldRow({
    key: 'skills',
    label: t('profile.skills.label'),
    checked: overviewState.skills.length > 0,
    currentValue: (current?.skills || []).map((s) => s.name).join(', '),
    control: `<div id="ri-ov-skills" class="${CLS.chipRow}"></div>`,
  });
  const toolsRow = overviewFieldRow({
    key: 'tools',
    label: t('profile.field.tools.label'),
    checked: overviewState.tools.length > 0,
    currentValue: (current?.tools || []).join(', '),
    control: `<div id="ri-ov-tools" class="${CLS.chipRow}"></div>`,
  });

  el.innerHTML = `
    <div class="space-y-2">
      ${subheadTitle(t('profile_import.overview.title'))}
      ${helpText(t('profile_import.overview.hint'))}
    </div>
    <div class="${CLS.card} space-y-4">
      ${inputRow('name', 'profile.field.name.label', overviewState.name, current?.name || '')}
      ${inputRow('headline', 'profile.field.headline.label', overviewState.headline, current?.headline || '')}
      ${textareaRow('summary', 'profile.field.summary.label', overviewState.summary, current?.summary || '')}
      ${inputRow('environment', 'profile.field.environment.label', overviewState.environment, current?.environment || '')}
      ${skillsRow}
      ${toolsRow}
    </div>
    <div class="space-y-2">
      ${inlineError({ id: 'ri-overview-apply-error' })}
      ${button({ id: 'ri-overview-apply', variant: 'primary', icon: 'check', label: t('profile_import.overview.apply') })}
    </div>`;
  el.classList.remove('hidden');
  renderOverviewPills();
  document.getElementById('ri-overview-apply')?.addEventListener('click', () => applyOverview(onExit));
};

const readOverviewEdits = () => {
  const el = document.getElementById('ri-overview-review');
  if (!el || !overviewState) return {};
  const payload = {};
  const checked = (key) => el.querySelector(`[data-ov-select="${key}"]`)?.checked;
  const val = (key) => el.querySelector(`[data-ov-field="${key}"]`)?.value ?? '';
  if (checked('name')) payload.name = val('name').trim();
  if (checked('headline')) payload.headline = val('headline').trim();
  if (checked('summary')) payload.summary = val('summary').trim();
  if (checked('environment')) payload.environment = val('environment').trim();
  if (checked('skills')) {
    payload.skills = mergeUnique(
      currentOverview?.skills, overviewState.skills,
      (s) => (s.name || '').toLowerCase().trim(),
    );
  }
  if (checked('tools')) {
    payload.tools = mergeUnique(
      currentOverview?.tools, overviewState.tools,
      (v) => String(v).toLowerCase().trim(),
    );
  }
  return payload;
};

const applyOverview = async (onExit) => {
  const btn = document.getElementById('ri-overview-apply');
  const payload = readOverviewEdits();
  const keys = Object.keys(payload);
  if (!keys.length) {
    setInlineError('ri-overview-apply-error', t('profile_import.overview.apply.none_selected'));
    return;
  }
  setInlineError('ri-overview-apply-error', '');
  if (btn) btn.disabled = true;
  try {
    await updateOverview(payload);
    toast(t('profile_import.overview.apply.summary', { applied: keys.length }), 'ok');
    onExit?.('overview');
  } catch (err) {
    setInlineError('ri-overview-apply-error', t('profile_import.overview.apply.failed', { error: err?.message || String(err) }));
  } finally {
    if (btn) btn.disabled = false;
  }
};

const runOverviewExtraction = async (onExit) => {
  const md = document.getElementById('ri-markdown')?.value?.trim();
  if (!md) {
    setOverviewError(t('profile_import.error.unsupported'));
    return;
  }
  setOverviewError('');
  const locale = currentLocale();
  const current = await getOverview();
  setOverviewStatus(true);
  try {
    const extracted = await extractOverviewFromResume(md, locale);
    setOverviewStatus(false);
    renderOverviewReview(extracted || {}, current || {}, onExit);
  } catch (err) {
    setOverviewStatus(false);
    const msg = err?.message || String(err);
    if (msg.includes('no_llm_configured') || msg.includes('setup')) {
      setOverviewError(t('profile_import.overview.error.no_llm'));
    } else {
      setOverviewError(t('profile_import.overview.error.generic', { error: msg }));
    }
  }
};

export const wireOverviewExtract = (onExit) => {
  const btn = document.getElementById('ri-overview-extract');
  if (!btn) return;
  btn.addEventListener('click', () => runOverviewExtraction(onExit));
};
