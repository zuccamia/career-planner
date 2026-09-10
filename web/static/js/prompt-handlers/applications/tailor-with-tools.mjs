// Tool-driven tailor handler: same output schema as tailor-draft-resume,
// but the LLM pulls brags/résumés on demand via search_brags /
// search_resumes tool calls.

import { buildFormattedWithJDPersona } from '../../sources/llm/prompts.mjs';
import { loadToolSchema } from '../../sources/llm/tool-schemas.mjs';
import { BULLET_WORD_CAP, parse as parseTailor } from './tailor-draft-resume.mjs';

const TOOL_SCHEMA_KEY = 'applications/tailor-with-tools';

export const parse = (raw, extras = {}) => parseTailor(raw, extras);

export const build = async (input, locale) => {
  const jd = input?.jd_structured;
  const profile = input?.profile;
  const base = input?.base_resume_structured;
  const signals = input?.role_signals ?? '';
  const fit = input?.profile_fit ?? '';
  if (!jd) throw new Error('jd_structured is required');
  if (!profile) throw new Error('profile is required');
  if (!base) throw new Error('base_resume_structured is required');
  const [formatted, tools] = await Promise.all([
    buildFormattedWithJDPersona('applications/tailor-with-tools', locale, jd,
      String(BULLET_WORD_CAP),
      signals,
      fit,
      JSON.stringify(jd),
      JSON.stringify(profile),
      JSON.stringify(base),
    ),
    loadToolSchema(TOOL_SCHEMA_KEY),
  ]);
  return { ...formatted, tools };
};
