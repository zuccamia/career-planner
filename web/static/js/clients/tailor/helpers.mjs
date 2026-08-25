// ---- budget ----

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

// ---- coverage ----

// Deterministic ATS-keyword coverage check for a tailored resume. The LLM
// gives us a keyword list (analyze-role-signals → ats_keywords); this helper
// tells us which of them landed in the tailored draft. Coverage decisions
// stay in-house — no LLM self-report to trust.

// Escapes regex metacharacters in a keyword so we can compile a word-bounded
// literal match. `Go` should hit "wrote Go" but not "Google".
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const matchRE = (kw) => new RegExp(`(?:^|\\W)${escapeRe(kw)}(?:\\W|$)`, 'i');

// keywordsInText returns the subset of `keywords` that appear in `text`.
// Case-insensitive, word-bounded. Order matches the input keyword order.
export const keywordsInText = (text, keywords) => {
  const t = String(text ?? '');
  if (!t || !keywords?.length) return [];
  const out = [];
  for (const kw of keywords) {
    const trimmed = String(kw ?? '').trim();
    if (!trimmed) continue;
    if (matchRE(trimmed).test(t)) out.push(kw);
  }
  return out;
};

// flattenResume joins the searchable text of a ResumeStructured into one
// blob. Contact intentionally excluded — ATS keywords describe role/skill
// content and hard qualifications (degrees, certs, majors), not identity.
const flattenResume = (resume) => {
  const parts = [];
  for (const ed of resume?.education ?? []) {
    parts.push(ed.school ?? '', ed.degree ?? '', ed.location ?? '');
  }
  for (const grp of resume?.skills ?? []) {
    parts.push(grp.label ?? '');
    for (const item of grp.items ?? []) parts.push(item);
  }
  for (const role of resume?.experience ?? []) {
    parts.push(role.title ?? '', role.company ?? '', role.division ?? '');
    for (const b of role.bullets ?? []) {
      parts.push(b.lead_in ?? '', b.description ?? '');
    }
  }
  for (const p of resume?.projects ?? []) {
    parts.push(p.name ?? '', p.subtitle ?? '', p.description ?? '');
  }
  for (const a of resume?.activities ?? []) {
    parts.push(a.name ?? '', a.subtitle ?? '', a.description ?? '');
  }
  return parts.filter(Boolean).join(' \n ');
};

// computeATSCoverage returns { total, present, missing } for a resume vs a
// keyword list. Empty keyword list returns zeros.
export const computeATSCoverage = (resume, atsKeywords) => {
  const kws = (Array.isArray(atsKeywords) ? atsKeywords : [])
    .map((k) => String(k ?? '').trim())
    .filter(Boolean);
  if (!kws.length) return { total: 0, present: [], missing: [] };
  const blob = flattenResume(resume);
  const present = [];
  const missing = [];
  for (const kw of kws) {
    if (matchRE(kw).test(blob)) present.push(kw);
    else missing.push(kw);
  }
  return { total: kws.length, present, missing };
};
