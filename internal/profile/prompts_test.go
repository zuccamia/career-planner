package profile

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

func init() { testutil.MustLoadPrompts() }

func TestPromptsCoverManifest(t *testing.T) {
	for name, sets := range map[string]llm.PromptSets{
		"extractOverviewPrompts":         extractOverviewPrompts(),
		"extractStructuredResumePrompts": extractStructuredResumePrompts(),
	} {
		for _, code := range testutil.Locales(t) {
			if _, ok := sets[code]; !ok {
				t.Errorf("%s missing locale %q", name, code)
			}
		}
	}
}
