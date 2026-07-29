package brags

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Per-feature prompts, keyed by output locale. Content lives in
// prompts_{locale}.go — this file only assembles the maps. Missing locales
// fall back via llm.PickPromptSet.
var generateTagsPrompts = llm.PromptSets{
	"en": generateTagsEN,
	"vi": generateTagsVI,
}
