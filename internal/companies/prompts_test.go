package companies

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
)

func init() { testutil.MustLoadPrompts() }

func TestPromptsCoverManifest(t *testing.T) {
	sets := companyCandidatePrompts()
	for _, code := range testutil.Locales(t) {
		if _, ok := sets[code]; !ok {
			t.Errorf("companyCandidatePrompts missing locale %q", code)
		}
	}
}
