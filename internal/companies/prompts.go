package companies

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompt getters. Content lives in
// web/static/i18n/prompts/{module}/{name}.{locale}.json — loaded by
// llm.LoadPrompts in app.New() so the same files can also be fetched by the
// browser BYOK path. Wrapped as functions (not vars) to defer the PromptSet
// lookup until request time; a package-var init would resolve before
// LoadPrompts has run.
func lookupCompanyPrompts() llm.PromptSets { return llm.PromptSet("companies/lookup") }
func buildDossierPrompts() llm.PromptSets  { return llm.PromptSet("companies/build-dossier") }
