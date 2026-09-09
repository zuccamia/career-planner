// Ports internal/profile/service.go FinalizeStructuredResume +
// finalizeContact + finalizeNamedEntries + BuildExtractStructuredResumePrompt.
// Every empty section is dropped (no key emitted at all) to mirror Go's
// omitempty on the wire.

import { decodeJSONResponse, buildFromField } from '../../sources/llm/prompts.mjs';
import { isSuspiciousText } from '../../sources/llm/safety.mjs';
import { t } from '../../i18n.mjs';

const cleanScalar = (s) => {
  const t = (s ?? '').trim();
  if (!t || isSuspiciousText(t)) return '';
  return t;
};

const finalizeContact = (c = {}) => {
  const links = [];
  for (const l of c.links ?? []) {
    const url = (l.url ?? '').trim();
    if (!url || isSuspiciousText(url)) continue;
    links.push({ label: cleanScalar(l.label), url });
  }
  const contact = { name: cleanScalar(c.name) };
  if (c.email)    contact.email    = cleanScalar(c.email);
  if (c.phone)    contact.phone    = cleanScalar(c.phone);
  if (c.location) contact.location = cleanScalar(c.location);
  if (links.length) contact.links = links;
  return contact;
};

const finalizeNamedEntries = (in_) => {
  const out = [];
  for (const e of in_ ?? []) {
    const name = cleanScalar(e.name);
    if (!name) continue;
    let url = (e.url ?? '').trim();
    if (isSuspiciousText(url)) url = '';
    const entry = { name };
    if (url)              entry.url = url;
    const subtitle = cleanScalar(e.subtitle);
    if (subtitle)         entry.subtitle = subtitle;
    const description = cleanScalar(e.description);
    if (description)      entry.description = description;
    out.push(entry);
  }
  return out;
};

export const finalizeImportResume = (out = {}) => {
  const result = { contact: finalizeContact(out.contact) };

  const edu = [];
  for (const e of out.education ?? []) {
    const school = cleanScalar(e.school);
    if (!school) continue;
    const row = { school };
    const location = cleanScalar(e.location); if (location) row.location = location;
    const degree   = cleanScalar(e.degree);   if (degree)   row.degree   = degree;
    const dates    = cleanScalar(e.dates);    if (dates)    row.dates    = dates;
    edu.push(row);
  }
  if (edu.length) result.education = edu;

  const skills = [];
  for (const g of out.skills ?? []) {
    const label = cleanScalar(g.label);
    const items = [];
    for (const it of g.items ?? []) {
      const t = cleanScalar(it);
      if (t) items.push(t);
    }
    if (!label && items.length === 0) continue;
    skills.push({ label, items });
  }
  if (skills.length) result.skills = skills;

  const exp = [];
  for (const e of out.experience ?? []) {
    const company = cleanScalar(e.company);
    if (!company) continue;
    const bullets = [];
    for (const b of e.bullets ?? []) {
      const desc = cleanScalar(b.description);
      const lead = cleanScalar(b.lead_in);
      if (!desc && !lead) continue;
      const item = { description: desc };
      if (lead) item.lead_in = lead;
      bullets.push(item);
    }
    const row = { company };
    const location = cleanScalar(e.location); if (location) row.location = location;
    const title    = cleanScalar(e.title);    if (title)    row.title    = title;
    const division = cleanScalar(e.division); if (division) row.division = division;
    const dates    = cleanScalar(e.dates);    if (dates)    row.dates    = dates;
    if (bullets.length) row.bullets = bullets;
    exp.push(row);
  }
  if (exp.length) result.experience = exp;

  const projects = finalizeNamedEntries(out.projects);
  if (projects.length) result.projects = projects;
  const activities = finalizeNamedEntries(out.activities);
  if (activities.length) result.activities = activities;

  return result;
};

export const parse = (raw) => finalizeImportResume(decodeJSONResponse(raw));

// Lossless text projection with `[N]` index anchors so ranker output can
// point at role/bullet/entry positions. Contact excluded.
const nonEmpty = (parts) => parts.filter((p) => p && String(p).trim());

export const flattenBaseResume = (resume) => {
  if (!resume) return '';
  const lines = [];
  const exp = resume.experience ?? [];
  if (exp.length) {
    lines.push('EXPERIENCE');
    exp.forEach((role, i) => {
      lines.push(`[${i}] ${nonEmpty([role?.company, role?.title, role?.dates]).join(' | ')}`);
      (role?.bullets ?? []).forEach((b, j) => {
        const text = b?.lead_in ? `${b.lead_in}: ${b.description ?? ''}` : (b?.description ?? '');
        lines.push(`  [${j}] ${text}`);
      });
    });
    lines.push('');
  }
  const skills = resume.skills ?? [];
  if (skills.length) {
    lines.push('SKILLS');
    for (const grp of skills) lines.push(`- ${grp?.label ?? ''}: ${(grp?.items ?? []).join(', ')}`);
    lines.push('');
  }
  for (const [key, label] of [['projects', 'PROJECTS'], ['activities', 'ACTIVITIES']]) {
    const entries = resume[key] ?? [];
    if (!entries.length) continue;
    lines.push(label);
    entries.forEach((e, i) => lines.push(`[${i}] ${nonEmpty([e?.name, e?.description]).join(' — ')}`));
    lines.push('');
  }
  const education = resume.education ?? [];
  if (education.length) {
    lines.push('EDUCATION');
    for (const ed of education) lines.push(`- ${nonEmpty([ed?.school, ed?.degree, ed?.dates]).join(', ')}`);
  }
  return lines.join('\n').trim();
};

// Prompt is format-neutral; the source string may be Markdown or Typst.
// Callers pass it under `source`, `markdown`, or `typst` — first non-empty wins.
export const build = async (input, locale) => {
  const source = (input?.source ?? '').trim() || (input?.markdown ?? '').trim() || (input?.typst ?? '').trim();
  if (!source) throw new Error(t('profile.resumes.error.source_required'));
  return buildFromField('profile/import-resume', { source }, 'source', locale);
};
