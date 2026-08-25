// Ports internal/people/service.go: FinalizeMessage +
// BuildMessagePrompt. Reuses buildThreadContext from summarize-thread.mjs.

import { decodeJSONResponse, buildFormatted } from '../../sources/llm/prompts.mjs';
import { sanitizeText } from '../../sources/llm/safety.mjs';
import { buildThreadContext } from './summarize-thread.mjs';

export const finalizeMessage = (out) => sanitizeText(out?.message);

export const parse = (raw) => ({ message: finalizeMessage(decodeJSONResponse(raw)) });

export const build = async (input, locale) => {
  const goal = (input?.goal ?? '').trim().toLowerCase();
  if (goal !== 'outreach' && goal !== 'reply') throw new Error('invalid communication goal');
  return buildFormatted('people/generate-message', locale, goal, buildThreadContext(input));
};
