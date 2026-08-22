// exceedsOnePage reports whether the tailored output likely exceeded one
// page, by checking the tailor prompt's per-section budget (per-role
// bullets, skill groups, projects, activities — all capped at the base's
// counts). Heuristic, not a layout measurement; the panel surfaces a
// "best-effort one-page" warning when true.
export const exceedsOnePage = (resume, base) => {
  const baseExp = base?.experience ?? [];
  const outExp = resume?.experience ?? [];
  if (baseExp.length && outExp.length > baseExp.length) return true;
  for (let i = 0; i < outExp.length && i < baseExp.length; i++) {
    const bulletCap = (baseExp[i]?.bullets ?? []).length;
    const bullets = outExp[i]?.bullets ?? [];
    if (bulletCap && bullets.length > bulletCap) return true;
  }
  const baseSkills = base?.skills ?? [];
  if (baseSkills.length && (resume?.skills ?? []).length > baseSkills.length) return true;
  for (const key of ['projects', 'activities']) {
    const baseEntries = base?.[key] ?? [];
    const outEntries = resume?.[key] ?? [];
    if (baseEntries.length && outEntries.length > baseEntries.length) return true;
  }
  return false;
};
