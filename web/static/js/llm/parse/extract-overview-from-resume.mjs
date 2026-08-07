// Ports internal/profile/service.go: FinalizeExtracted for ExtractedOverview
// + BuildExtractFromResumePrompt.

import { decodeJSONResponse } from '../decode.mjs';
import { isSuspiciousText } from '../safety.mjs';
import { buildFromField } from '../prompts.mjs';

const SKILL_LEVELS = new Set(['beginner', 'intermediate', 'advanced', 'expert']);

const cleanScalar = (s) => {
  const t = (s ?? '').trim();
  if (!t) return '';
  if (isSuspiciousText(t)) return '';
  return t;
};

export const finalizeExtracted = (out) => {
  const skills = [];
  const seenSkill = new Set();
  for (const raw of out?.skills ?? []) {
    const name = cleanScalar(raw.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenSkill.has(key)) continue;
    seenSkill.add(key);
    const sk = { name };
    if (typeof raw.years === 'number' && raw.years > 0 && raw.years < 100) sk.years = raw.years;
    if (raw.level) {
      const lvl = String(raw.level).trim().toLowerCase();
      if (SKILL_LEVELS.has(lvl)) sk.level = lvl;
    }
    skills.push(sk);
  }

  const tools = [];
  const seenTool = new Set();
  for (const raw of out?.tools ?? []) {
    const t = cleanScalar(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seenTool.has(key)) continue;
    seenTool.add(key);
    tools.push(t);
  }

  return {
    name:        cleanScalar(out?.name),
    headline:    cleanScalar(out?.headline),
    summary:     cleanScalar(out?.summary),
    environment: cleanScalar(out?.environment),
    skills,
    tools,
  };
};

export const parse = (raw) => finalizeExtracted(decodeJSONResponse(raw));

export const build = async (input, locale) => buildFromField('extract-overview-from-resume', input, 'markdown', locale);
