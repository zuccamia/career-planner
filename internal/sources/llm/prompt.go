package llm

// PromptSets holds one Prompt per locale for a single feature. User is a
// fmt.Sprintf template; the caller interpolates feature inputs before dispatch.
type PromptSets map[string]Prompt

// DefaultPromptLocale is the fallback when a requested locale has no entry.
// Kept independent of internal/i18n to avoid an import cycle.
const DefaultPromptLocale = "en"

// PickPromptSet returns sets[lang], or the DefaultPromptLocale entry when lang
// is missing. Returns a zero Prompt if neither exists — the "en" entry is
// expected to always be present.
func PickPromptSet(sets PromptSets, lang string) Prompt {
	if p, ok := sets[lang]; ok {
		return p
	}
	return sets[DefaultPromptLocale]
}
