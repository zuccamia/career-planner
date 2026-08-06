package profile

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Locale-keyed prompt content lives in prompts_{locale}.go; this file only
// assembles the maps. Missing locales fall back via llm.PickPromptSet.
var extractOverviewPrompts = llm.PromptSets{
	"en": extractOverviewEN,
	"vi": extractOverviewVI,
}

var extractStructuredResumePrompts = llm.PromptSets{
	"en": extractStructuredResumeEN,
	"vi": extractStructuredResumeVI,
}
