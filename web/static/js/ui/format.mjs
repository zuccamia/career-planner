// Shared formatting helpers used across page slide-overs.

import { t } from '../i18n.mjs';

export const relativeAge = (iso) => {
  if (!iso) return '';
  const thenDate = new Date(iso);
  const then = thenDate.getTime();
  if (Number.isNaN(then)) return '';
  const nowMs = Date.now();
  const deltaMs = Math.max(0, nowMs - then);
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 1) return t('common.age.just_now');
  if (hours === 1) return t('common.age.hour_one');
  if (hours < 24) return t('common.age.hour_many', { n: hours });
  const days = Math.floor(deltaMs / 86_400_000);
  if (days === 1) return t('common.age.day_one');
  if (days < 30) return t('common.age.day_many', { n: days });
  // Calendar-accurate months/years: compare Y/M components and subtract one
  // when the day-of-month hasn't rolled over yet, so "11 months and 20 days"
  // reads as "11 months ago", not "1 year ago".
  const now = new Date(nowMs);
  let months = (now.getFullYear() - thenDate.getFullYear()) * 12
    + (now.getMonth() - thenDate.getMonth());
  if (now.getDate() < thenDate.getDate()) months -= 1;
  if (months <= 1) return t('common.age.month_one');
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

// prettifySlug: "high-agency-labs" → "High Agency Labs"; already-capitalized
// slugs are left alone so acronyms stay upper. Mirrors ats.PrettifySlug in
// internal/sources/ats/providers.go for URL-slug → company-name display.
export const prettifySlug = (s) => {
  const cleaned = (s || '').replace(/[-_]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/).map(w => (
    w && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w
  )).join(' ');
};

// resumePdfFilename builds the download filename. Resume titles typically
// encode the target ("Company - Role"), so the title acts as the version
// differentiator; the YYMMDD stamp at the end is a lightweight audit trail
// for "which draft did I send them" cross-referencing.
//
//   name + title  → "{name} - {title} - YYMMDD.pdf"
//                    e.g. "Ada Lovelace - Stripe - Backend Engineer - 260814.pdf"
//   name only     → "{name} - CV - YYMMDD.pdf"
//   fallback only → "{fallback} - YYMMDD.pdf"
//   nothing usable → "resume - YYMMDD.pdf"
//
// All branches strip filesystem-hostile characters. `date` is caller-injectable
// for deterministic tests; production callers omit it and get today.
const stripFsHostile = (s) =>
  String(s ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();

export const resumePdfFilename = ({ name, title, fallback, date } = {}) => {
  const d = date instanceof Date ? date : new Date();
  // Local time so the stamp matches the wall clock the user sees when they
  // hit "download" — a UTC stamp is off by a day for evenings in Asia and
  // early mornings in the Americas.
  const stamp = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const cleanName = stripFsHostile(name);
  const cleanTitle = stripFsHostile(title);
  if (cleanName && cleanTitle) return `${cleanName} - ${cleanTitle} - ${stamp}.pdf`;
  if (cleanName)               return `${cleanName} - CV - ${stamp}.pdf`;
  const cleanFallback = stripFsHostile(fallback) || 'resume';
  return `${cleanFallback} - ${stamp}.pdf`;
};
