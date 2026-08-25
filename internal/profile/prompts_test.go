package profile

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// init loads shared prompt JSON before any test in this package runs — some
// service tests exercise prompt-building call paths that hit llm.PromptSet.
func init() { testutil.MustLoadPrompts() }

func TestPromptsCoverManifest(t *testing.T) {
	for name, sets := range map[string]llm.PromptSets{
		"importOverviewPrompts":   importOverviewPrompts(),
		"importResumePrompts":     importResumePrompts(),
		"generateBragTagsPrompts": generateBragTagsPrompts(),
		"importBragsPrompts":      importBragsPrompts(),
	} {
		for _, code := range testutil.Locales(t) {
			if _, ok := sets[code]; !ok {
				t.Errorf("%s missing locale %q", name, code)
			}
		}
	}
}
