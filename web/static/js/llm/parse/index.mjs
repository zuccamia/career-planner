// Dispatch tables for the browser BYOK build/parse steps. Keys match the
// BYOK URL name segment (see internal/http/byok.go's rpcBYOKPrompt and
// rpcBYOKParse switches) so a caller can look up `builders[name]` and
// `parsers[name]` without a translation layer.
//
// - builders[name](input, locale) → { system, user, ...extras }
// - parsers[name](raw, extras?)   → normalized response body
//
// Extras carry per-flow context (e.g. enriched_raw + posting for
// extract-job-description) that the build step captured and the parse
// step needs.

import * as guessCandidate               from './guess-candidate.mjs';
import * as buildDossier                  from './build-dossier.mjs';
import * as generateBragTags              from './generate-brag-tags.mjs';
import * as extractBragsFromResume        from './extract-brags-from-resume.mjs';
import * as extractOverviewFromResume     from './extract-overview-from-resume.mjs';
import * as extractStructuredResumeFromMd from './extract-structured-resume-from-md.mjs';
import * as summarizeThread               from './summarize-thread.mjs';
import * as generateMessage               from './generate-message.mjs';
import * as extractJobDescription         from './extract-job-description.mjs';

const modules = {
  'guess-candidate':                   guessCandidate,
  'build-dossier':                     buildDossier,
  'generate-brag-tags':                generateBragTags,
  'extract-brags-from-resume':         extractBragsFromResume,
  'extract-overview-from-resume':      extractOverviewFromResume,
  'extract-structured-resume-from-md': extractStructuredResumeFromMd,
  'summarize-thread':                  summarizeThread,
  'generate-message':                  generateMessage,
  'extract-job-description':           extractJobDescription,
};

export const parsers  = Object.fromEntries(Object.entries(modules).map(([n, m]) => [n, m.parse]));
export const builders = Object.fromEntries(Object.entries(modules).map(([n, m]) => [n, m.build]));
