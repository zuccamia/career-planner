// JS port of internal/discover/query.go for the BYOK pipeline. Diverges from
// Go in one place: no `site:` operator (Tavily ignores it; caller passes
// include_domains). Single-rung — no fallback ladder, to protect BYOK quota.

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

// buildSiteScopedQuery composes (roleGroup) (signalGroup) (locationGroup)
// (empGroup); empty groups drop. Scarce employment collapses role to
// broadRole and drops signals, mirroring query.go.
export const buildSiteScopedQuery = (host, roles, broadRole, signals, locations, employmentType) => {
  if (!host || !host.host) return '';
  if (isScarceEmployment(employmentType)) {
    if (broadRole && broadRole.trim()) roles = [broadRole.trim()];
    else if (roles?.length > 0) roles = roles.slice(0, 1);
    signals = null;
  }
  const groups = [roles, signals, locations, employmentTitleKeywords[employmentType]];
  if (isScarceEmployment(employmentType)) groups.push(seasonalYears());
  return groups.map(composeORGroup).filter(Boolean).join(' ');
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

