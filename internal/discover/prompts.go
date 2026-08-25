package discover

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompt getters. Content lives in
// web/static/i18n/prompts/{module}/{name}.{locale}.json — loaded by
// llm.LoadPrompts in app.New(). Wrapped as functions (not vars) to defer the
// PromptSet lookup until request time; a package-var init would resolve
// before LoadPrompts has run.
func expandQueryPrompts() llm.PromptSets { return llm.PromptSet("discover/expand-query") }
func rankJobsPrompts() llm.PromptSets    { return llm.PromptSet("discover/rank-jobs") }
