// Remote / Hybrid / Onsite choice-card row (aka "workplace type" in
// LinkedIn/Google Jobs parlance). Shared by the flat profile form and the
// wizard's workplace-type step. workplaceTypeCardsHtml renders the row
// markup; wireWorkplaceTypeCards attaches click handlers that toggle the
// selection, re-render so the active palette follows, and invoke onChange
// for persistence. currentValue is 'remote' | 'hybrid' | 'onsite' or ''
// (nothing chosen).

import { CLS } from './classes.mjs';
import { t } from '../i18n.mjs';

const CHOICES = ['remote', 'hybrid', 'onsite'];

const cardHtml = (choice, activeValue) => {
  const active = choice === activeValue;
  const palette = active ? CLS.choiceCardActive : CLS.choiceCardInactive;
  return `
    <button type="button" class="${CLS.choiceCardBase} ${palette} js-workplace-type-choice" data-workplace-type="${choice}" aria-pressed="${active}">
      <span class="${CLS.choiceCardTitle}">${t(`profile.workplace_type.card.${choice}.title`)}</span>
      <span class="${CLS.choiceCardHelp}">${t(`profile.workplace_type.card.${choice}.help`)}</span>
    </button>
  `;
};

export const workplaceTypeCardsHtml = (activeValue) =>
  CHOICES.map((c) => cardHtml(c, activeValue)).join('');

export const wireWorkplaceTypeCards = ({ mountEl, currentValue, onChange }) => {
  let value = currentValue || '';
  const rerender = () => {
    mountEl.innerHTML = workplaceTypeCardsHtml(value);
    mountEl.querySelectorAll('.js-workplace-type-choice').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const clicked = btn.dataset.workplaceType;
        const next = value === clicked ? '' : clicked;
        try { await onChange(next); }
        catch { return; }
        value = next;
        rerender();
      });
    });
  };
  rerender();
};
