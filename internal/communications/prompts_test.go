package communications

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

func TestPromptsCoverManifest(t *testing.T) {
	assertCoversManifest(t, "summarizePrompts", summarizePrompts)
	assertCoversManifest(t, "messagePrompts", messagePrompts)
}

func assertCoversManifest(t *testing.T, name string, sets llm.PromptSets) {
	t.Helper()
	for _, code := range testutil.Locales(t) {
		if _, ok := sets[code]; !ok {
			t.Errorf("%s missing locale %q", name, code)
		}
	}
}
