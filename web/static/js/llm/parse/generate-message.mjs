// Ports internal/communications/service.go: FinalizeMessage +
// BuildMessagePrompt. Reuses buildThreadContext from summarize-thread.mjs.

import { decodeJSONResponse } from '../decode.mjs';
import { sanitizeText } from '../safety.mjs';
import { buildFormatted } from '../prompts.mjs';
import { buildThreadContext } from './summarize-thread.mjs';

export const finalizeMessage = (out) => sanitizeText(out?.message);

export const parse = (raw) => ({ message: finalizeMessage(decodeJSONResponse(raw)) });

export const build = async (input, locale) => {
  const goal = (input?.goal ?? '').trim().toLowerCase();
  if (goal !== 'outreach' && goal !== 'reply') throw new Error('invalid communication goal');
  return buildFormatted('generate-message', locale, goal, buildThreadContext(input));
};
