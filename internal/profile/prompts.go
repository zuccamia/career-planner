package profile

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompt getters. Content lives in
// web/static/i18n/prompts/{name}.{locale}.json — loaded by llm.LoadPrompts in
// app.New() so the same files can also be fetched by the browser BYOK path.
// Wrapped as functions (not vars) to defer the PromptSet lookup until request
// time; a package-var init would resolve before LoadPrompts has run.
func extractOverviewPrompts() llm.PromptSets         { return llm.PromptSet("extract-overview-from-resume") }
func extractStructuredResumePrompts() llm.PromptSets { return llm.PromptSet("extract-structured-resume-from-md") }
