package profile

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompt getters. Content lives in
// web/static/i18n/prompts/{module}/{name}.{locale}.json — loaded by
// llm.LoadPrompts in app.New() so the same files can also be fetched by the
// browser BYOK path. Wrapped as functions (not vars) to defer the PromptSet
// lookup until request time; a package-var init would resolve before
// LoadPrompts has run.
func importOverviewPrompts() llm.PromptSets   { return llm.PromptSet("profile/import-overview") }
func importResumePrompts() llm.PromptSets     { return llm.PromptSet("profile/import-resume") }
func generateBragTagsPrompts() llm.PromptSets { return llm.PromptSet("profile/generate-brag-tags") }
func importBragsPrompts() llm.PromptSets      { return llm.PromptSet("profile/import-brags") }
