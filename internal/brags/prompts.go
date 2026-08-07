package brags

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompt getters. Content lives in
// web/static/i18n/prompts/{name}.{locale}.json — loaded by llm.LoadPrompts in
// app.New() so the same files can also be fetched by the browser BYOK path.
// Wrapped as functions (not vars) to defer the PromptSet lookup until request
// time; a package-var init would resolve before LoadPrompts has run.
func generateTagsPrompts() llm.PromptSets     { return llm.PromptSet("generate-brag-tags") }
func extractFromResumePrompts() llm.PromptSets { return llm.PromptSet("extract-brags-from-resume") }
