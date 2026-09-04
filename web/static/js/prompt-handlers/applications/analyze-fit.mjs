// Analyze the role-signals rubric + profile + brags into a candidate-side
// fit rubric. Output is a single markdown blob — unstructured so prompt
// iteration doesn't touch the schema.

import { decodeJSONResponse, buildFormatted } from '../../sources/llm/prompts.mjs';
import { sanitizeText } from '../../sources/llm/safety.mjs';

export const parse = (raw) => {
  const decoded = decodeJSONResponse(raw) ?? {};
  return { fit: sanitizeText(decoded.fit ?? '') };
};

export const build = async (input, locale) => {
  const rubric = (input?.role_signals || '').trim();
  if (!rubric) throw new Error('role_signals is required');
  const ats = Array.isArray(input?.ats_keywords) ? input.ats_keywords : [];
  const rubricWithATS = ats.length
    ? `${rubric}\n\n### ATS keywords\n${ats.join(', ')}`
    : rubric;
  return buildFormatted('applications/analyze-fit', locale,
    rubricWithATS,
    JSON.stringify(input?.profile ?? {}),
    JSON.stringify(input?.brags ?? []),
  );
};
