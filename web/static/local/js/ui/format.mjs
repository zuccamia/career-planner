// Shared formatting helpers used across page slide-overs.

import { t } from '../i18n.mjs';

export const relativeAge = (iso) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 1) return t('common.age.today');
  if (days === 1) return t('common.age.day_one');
  if (days < 30) return t('common.age.day_many', { n: days });
  const months = Math.floor(days / 30);
  if (months === 1) return t('common.age.month_one');
  if (months < 12) return t('common.age.month_many', { n: months });
  const years = Math.floor(months / 12);
  return years === 1 ? t('common.age.year_one') : t('common.age.year_many', { n: years });
};

export const initials = (name) => (name || '')
  .replace(/[^\p{L} ]/gu, '')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map(w => w[0].toUpperCase())
  .join('');
