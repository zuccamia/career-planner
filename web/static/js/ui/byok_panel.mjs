// Shared markup + wiring for the three BYOK provider panels on Settings
// (LLM / scraper / search). All exports take the same `{ domPrefix, i18nPrefix }`
// pair so DOM ids and i18n keys line up automatically. wireByokPanel owns
// the fingerprint-based test-before-save flow: Save stays disabled until Test
// succeeds against the current field values; any edit invalidates that state.

import { toast } from './toast.mjs';
import { button, setInlineError, inlineError, helpText } from './components.mjs';
import { icon } from './icons.mjs';
import { CLS } from './classes.mjs';
import { escapeHtml } from './dom.mjs';
import { t } from '../i18n.mjs';

// ---------- markup ----------

export const byokSectionHeader = ({ domPrefix, i18nPrefix }) => `
  <header class="space-y-1">
    <div class="${CLS.responsiveRow}">
      <p class="${CLS.eyebrow}">${t(`${i18nPrefix}.eyebrow`)}</p>
      <span id="${domPrefix}-status"></span>
    </div>
    ${helpText(t(`${i18nPrefix}.help`))}
  </header>
  ${inlineError({ id: `${domPrefix}-error` })}
`;

// options: e.g. ['firecrawl', 'crawl4ai'] — labels resolve via
// `${i18nPrefix}.field.provider.${value}`.
export const byokProviderRow = ({ domPrefix, i18nPrefix, options }) => `
  <label class="block ${CLS.bodyText}">
    ${t(`${i18nPrefix}.field.provider.label`)}
    <select id="${domPrefix}-provider" class="${CLS.input} mt-1">
      ${options.map((v) => `<option value="${v}">${t(`${i18nPrefix}.field.provider.${v}`)}</option>`).join('')}
    </select>
  </label>
`;

export const byokBaseURLRow = ({ domPrefix, i18nPrefix, placeholder }) => `
  <label class="block ${CLS.bodyText}">
    ${t(`${i18nPrefix}.field.base_url.label`)}
    <input id="${domPrefix}-base-url" type="url" placeholder="${escapeHtml(placeholder)}" class="${CLS.input} mt-1">
  </label>
`;

// hasNote=true when the i18n bundle includes `.field.api_key.note`.
export const byokAPIKeyRow = ({ domPrefix, i18nPrefix, placeholder, hasNote = false }) => `
  <label class="block ${CLS.bodyText}">
    ${t(`${i18nPrefix}.field.api_key.label`)}
    ${hasNote ? `<span class="ml-1 ${CLS.helpText}">${t(`${i18nPrefix}.field.api_key.note`)}</span>` : ''}
    <div class="mt-1 ${CLS.responsiveRow}">
      <input id="${domPrefix}-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" class="${CLS.input} flex-1">
      ${button({ id: `btn-${domPrefix}-reveal`, variant: 'icon', icon: 'eye', iconOnly: true, ariaLabel: t(`${i18nPrefix}.field.api_key.show`) })}
    </div>
  </label>
`;

export const byokActionsRow = ({ domPrefix, i18nPrefix }) => `
  <div class="${CLS.formRow}">
    ${button({ id: `btn-${domPrefix}-save`, variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: t(`${i18nPrefix}.action.save`), disabled: true })}
    ${button({ id: `btn-${domPrefix}-test`, variant: 'secondaryCompact', icon: 'link', label: t(`${i18nPrefix}.action.test`) })}
    ${button({ id: `btn-${domPrefix}-clear`, variant: 'dangerCompact', icon: 'trash', label: t(`${i18nPrefix}.action.clear`) })}
    <span id="${domPrefix}-test-result" class="${CLS.bodyText}"></span>
  </div>
`;

// ---------- wiring ----------

const wireRevealButton = (inputEl, btnEl, showKey, hideKey) => {
  btnEl.addEventListener('click', () => {
    const revealed = inputEl.type === 'password';
    inputEl.type = revealed ? 'text' : 'password';
    btnEl.innerHTML = icon(revealed ? 'eyeSlash' : 'eye');
    btnEl.setAttribute('aria-label', revealed ? t(hideKey) : t(showKey));
  });
};

// Extra behaviors that don't fit the state machine (e.g. the scraper panel's
// default-URL swap on provider <select> change) belong in the caller after
// `await wireByokPanel(...)` returns.
export const wireByokPanel = async ({
  domPrefix, i18nPrefix,
  fieldEls,              // ordered inputs whose values feed the fingerprint
  apiKeyEl,              // password field, cleared on Clear
  extraChangeEls = [],   // elements that only fire 'change' (e.g. <select>)
  loadConfig, saveConfig, clearConfig,
  hydrateForm,           // (cfg) => void: seed DOM from persisted cfg
  readForm,              // () => form object (fed into save/test/fingerprint)
  fingerprintOf,         // (cfgOrForm) => string, identical order for both
  validate,              // (form) => bool
  runTest,               // async (form) => { ok, error?, latencyMs?, ... }
  formatTestSuccess,     // (result) => string for testResultEl
  formatSavedToast,      // (form) => string
  onChange,              // async () => void: refresh status after save/clear
}) => {
  const $ = (id) => document.getElementById(id);
  const revealBtnEl  = $(`btn-${domPrefix}-reveal`);
  const testBtnEl    = $(`btn-${domPrefix}-test`);
  const saveBtnEl    = $(`btn-${domPrefix}-save`);
  const clearBtnEl   = $(`btn-${domPrefix}-clear`);
  const testResultEl = $(`${domPrefix}-test-result`);
  const errorSlotId  = `${domPrefix}-error`;
  const K = (k) => `${i18nPrefix}.${k}`;

  const cfg = await loadConfig();
  hydrateForm(cfg);

  let lastTestedFingerprint = cfg ? fingerprintOf(cfg) : null;
  const currentFingerprint = () => fingerprintOf(readForm());
  const syncSaveEnabled = () => {
    saveBtnEl.disabled = !lastTestedFingerprint || lastTestedFingerprint !== currentFingerprint();
  };
  syncSaveEnabled();
  fieldEls.forEach((el) => el.addEventListener('input', syncSaveEnabled));
  extraChangeEls.forEach((el) => el.addEventListener('change', syncSaveEnabled));

  wireRevealButton(apiKeyEl, revealBtnEl, K('field.api_key.show'), K('field.api_key.hide'));

  testBtnEl.addEventListener('click', async () => {
    setInlineError(errorSlotId, '');
    testResultEl.textContent = t(K('test.running'));
    const form = readForm();
    if (!validate(form)) {
      testResultEl.textContent = '';
      setInlineError(errorSlotId, t(K('error.test_missing_fields')));
      return;
    }
    const res = await runTest(form);
    if (res.ok) {
      testResultEl.textContent = formatTestSuccess(res);
      lastTestedFingerprint = currentFingerprint();
      syncSaveEnabled();
    } else {
      testResultEl.textContent = '';
      setInlineError(errorSlotId, t(K('test.failure'), { err: res.error, latency: res.latencyMs ?? '—' }));
    }
  });

  saveBtnEl.addEventListener('click', async () => {
    setInlineError(errorSlotId, '');
    const form = readForm();
    if (!validate(form)) {
      setInlineError(errorSlotId, t(K('error.save_missing_fields')));
      return;
    }
    await saveConfig(form);
    toast(formatSavedToast(form), 'ok');
    await onChange();
  });

  clearBtnEl.addEventListener('click', async () => {
    if (!confirm(t(K('confirm.clear')))) return;
    await clearConfig();
    apiKeyEl.value = '';
    testResultEl.textContent = '';
    lastTestedFingerprint = null;
    syncSaveEnabled();
    toast(t(K('toast.cleared')), 'info');
    await onChange();
  });
};
