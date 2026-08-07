package brags

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// init loads shared prompt JSON before any test in this package runs — some
// service tests exercise BuildXPrompt call paths that hit llm.PromptSet.
func init() { testutil.MustLoadPrompts() }

func TestPromptsCoverManifest(t *testing.T) {
	assertCoversManifest(t, "generateTagsPrompts", generateTagsPrompts())
	assertCoversManifest(t, "extractFromResumePrompts", extractFromResumePrompts())
}

func assertCoversManifest(t *testing.T, name string, sets llm.PromptSets) {
	t.Helper()
	for _, code := range testutil.Locales(t) {
		if _, ok := sets[code]; !ok {
			t.Errorf("%s missing locale %q", name, code)
		}
	}
}
