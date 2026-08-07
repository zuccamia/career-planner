// Ports internal/profile/service.go FinalizeStructuredResume +
// finalizeContact + finalizeNamedEntries + BuildExtractStructuredResumePrompt.
// Every empty section is dropped (no key emitted at all) to mirror Go's
// omitempty on the wire.

import { decodeJSONResponse } from '../decode.mjs';
import { isSuspiciousText } from '../safety.mjs';
import { buildFromField } from '../prompts.mjs';

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

export const finalizeStructuredResume = (out = {}) => {
  const result = { contact: finalizeContact(out.contact) };

  const summary = cleanScalar(out.summary);
  if (summary) result.summary = summary;

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

export const parse = (raw) => finalizeStructuredResume(decodeJSONResponse(raw));

export const build = async (input, locale) => buildFromField('extract-structured-resume-from-md', input, 'markdown', locale);
