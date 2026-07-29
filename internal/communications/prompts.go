package communications

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompts, keyed by output locale. Content lives in
// prompts_{locale}.go — this file only assembles the maps. Missing locales
// fall back via llm.PickPromptSet.

var summarizePrompts = llm.PromptSets{
	"en": summarizeEN,
	"vi": summarizeVI,
}

var messagePrompts = llm.PromptSets{
	"en": messageEN,
	"vi": messageVI,
}
