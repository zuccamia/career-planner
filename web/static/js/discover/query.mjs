// JS port of internal/discover/query.go. Kept in sync one-for-one so the
// BYOK pipeline generates the same site-scoped queries the server does.
//
// Single-rung strict query only — no fallback ladder here. Broader rungs
// on the server exist to widen recall via paid engines; the browser path
// spends the user's paid Tavily/Brave quota per host and shouldn't retry.

import { targetHireMonth, isScarceEmployment, employmentTitleKeywords } from './helpers.mjs';

// Mirrors query.go seasonalYears — year of targetHireMonth.
const seasonalYears = () => [String(targetHireMonth().getFullYear())];

// composeORGroup formats a term list as a Google-search OR group. One term
// returns `"term"`; multiple returns `("t1" OR "t2" OR ...)`. Empty input
// returns "". Dedupes case-insensitively.
const composeORGroup = (terms) => {
  const seen = new Set();
  const cleaned = [];
  for (const raw of terms || []) {
    const s = (raw ?? '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(s);
  }
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return `"${cleaned[0]}"`;
  return `(${cleaned.map((v) => `"${v}"`).join(' OR ')})`;
};

// buildSiteScopedQuery composes: site:{host} (roleGroup) (signalGroup)
// (locationGroup) (empGroup). Empty groups drop. Matches Go behavior for
// scarce employment types — role collapses to broadRole and signals drop.
export const buildSiteScopedQuery = (host, roles, broadRole, signals, locations, employmentType) => {
  if (!host || !host.host) return '';
  if (isScarceEmployment(employmentType)) {
    if (broadRole && broadRole.trim()) roles = [broadRole.trim()];
    else if (roles?.length > 0) roles = roles.slice(0, 1);
    signals = null;
  }
  const parts = [`site:${host.host}`];
  const groups = [roles, signals, locations, employmentTitleKeywords[employmentType]];
  if (isScarceEmployment(employmentType)) groups.push(seasonalYears());
  for (const group of groups) {
    const g = composeORGroup(group);
    if (g) parts.push(g);
  }
  return parts.join(' ');
};

// deriveLocationContext splits user locations into (mode, physical, remote?).
// Case-insensitive: a "remote"-prefixed entry counts as any-remote.
export const deriveLocationContext = (locations) => {
  const physical = [];
  let hasRemote = false;
  for (const raw of locations || []) {
    const s = (raw ?? '').trim();
    if (!s) continue;
    if (s.toLowerCase().startsWith('remote')) { hasRemote = true; continue; }
    physical.push(s);
  }
  if (physical.length === 0 && !hasRemote) return { location_mode: 'any', remote_ok: false };
  if (physical.length === 0 && hasRemote) return { location_mode: 'remote_only', remote_ok: true };
  if (physical.length > 0 && hasRemote) return { location_mode: 'cities_or_remote', physical_locations: physical, remote_ok: true };
  return { location_mode: 'cities_only', physical_locations: physical, remote_ok: false };
};

