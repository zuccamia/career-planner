package brags

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// TestPromptsCoverManifest guards against adding a locale to manifest.json
// without adding a corresponding entry to every prompt set — otherwise
// PickPromptSet would silently fall back to English for that locale.
func TestPromptsCoverManifest(t *testing.T) {
	assertCoversManifest(t, "generateTagsPrompts", generateTagsPrompts)
}

func assertCoversManifest(t *testing.T, name string, sets llm.PromptSets) {
	t.Helper()
	for _, code := range testutil.Locales(t) {
		if _, ok := sets[code]; !ok {
			t.Errorf("%s missing locale %q", name, code)
		}
	}
}
