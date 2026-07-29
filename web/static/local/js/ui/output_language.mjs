// Small <select> for picking the LLM output language per generation. Sits
// beside a "Generate" button; defaults to the UI locale. No persistence — the
// choice applies to the current click only (artifact-level persistence lives
// in a separate phase). Reader helper reads back the value at submit time.

import { SUPPORTED, currentLocale, localeDisplayName, t } from '../i18n.mjs';
import { CLS } from './classes.mjs';

// outputLanguageSelect renders a compact <select>. id must be unique per form.
// Options are the currently-supported locales; the current UI locale is
// pre-selected. Falls through to the browser default when SUPPORTED is empty
// (initI18n hasn't run yet, which shouldn't happen from a page module).
export const outputLanguageSelect = (id) => {
  const active = currentLocale();
  const options = SUPPORTED.map(code =>
    `<option value="${code}"${code === active ? ' selected' : ''}>${localeDisplayName(code)}</option>`,
  ).join('');
  return `
    <label class="flex items-center gap-2 text-xs text-slate-500">
      <span>${t('common.output_language')}</span>
      <select id="${id}" class="${CLS.inputBase} py-1.5 pl-2 pr-7 text-xs">${options}</select>
    </label>
  `;
};

// readOutputLanguage returns the selected value, or the current UI locale if
// the element is missing (defensive — should never happen when the caller
// mounted a matching outputLanguageSelect).
export const readOutputLanguage = (id) => {
  const el = document.getElementById(id);
  return (el && el.value) || currentLocale();
};
