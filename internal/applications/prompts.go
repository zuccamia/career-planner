package applications

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompt getters. Content lives in
// web/static/i18n/prompts/{name}.{locale}.json — loaded by llm.LoadPrompts in
// app.New() so the same files can also be fetched by the browser BYOK path.
// Wrapped as functions (not vars) to defer the PromptSet lookup until request
// time; a package-var init would resolve before LoadPrompts has run.
func extractJobDescriptionPrompts() llm.PromptSets {
	return llm.PromptSet("extract-job-description")
}

func tailorRankBragsPrompts() llm.PromptSets {
	return llm.PromptSet("tailor-rank-brags")
}

func tailorDraftResumePrompts() llm.PromptSets {
	return llm.PromptSet("tailor-draft-resume")
}

func analyzeRoleSignalsPrompts() llm.PromptSets {
	return llm.PromptSet("analyze-role-signals")
}
