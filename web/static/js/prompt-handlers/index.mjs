// Dispatch tables for the browser BYOK build/parse steps. Keys are the
// slash-style prompt keys (`{module}/{verb}-{object}`) and match the BYOK
// URL name segment (see internal/http/byok.go's rpcBYOKPrompt and rpcBYOKParse
// switches) so a caller can look up `builders[name]` and `parsers[name]`
// without a translation layer.
//
// - builders[name](input, locale) → { system, user, ...extras }
// - parsers[name](raw, extras?)   → normalized response body
//
// Extras carry per-flow context (e.g. enriched_raw + posting for
// applications/extract-job-description) that the build step captured and the
// parse step needs.

import * as lookup                      from './companies/lookup.mjs';
import * as buildDossier                from './companies/build-dossier.mjs';
import * as generateBragTags            from './profile/generate-brag-tags.mjs';
import * as importBrags                 from './profile/import-brags.mjs';
import * as importOverview              from './profile/import-overview.mjs';
import * as importResume                from './profile/import-resume.mjs';
import * as summarizeThread             from './people/summarize-thread.mjs';
import * as generateMessage             from './people/generate-message.mjs';
import * as extractJobDescription       from './applications/extract-job-description.mjs';
import * as analyzeRoleSignals          from './applications/analyze-role-signals.mjs';
import * as analyzeFit                  from './applications/analyze-fit.mjs';

// applications/tailor-rank-brags + applications/tailor-draft-resume are
// composed by tailor-client.mjs (not dispatched via llmCall) — see
// web/static/js/tailor/{rank,draft}.mjs.

const modules = {
  'companies/lookup':                      lookup,
  'companies/build-dossier':               buildDossier,
  'profile/generate-brag-tags':            generateBragTags,
  'profile/import-brags':                  importBrags,
  'profile/import-overview':               importOverview,
  'profile/import-resume':                 importResume,
  'people/summarize-thread':               summarizeThread,
  'people/generate-message':               generateMessage,
  'applications/extract-job-description':  extractJobDescription,
  'applications/analyze-role-signals':     analyzeRoleSignals,
  'applications/analyze-fit':              analyzeFit,
};

export const parsers  = Object.fromEntries(Object.entries(modules).map(([n, m]) => [n, m.parse]));
export const builders = Object.fromEntries(Object.entries(modules).map(([n, m]) => [n, m.build]));
