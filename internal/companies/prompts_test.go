package companies

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
)

func TestPromptsCoverManifest(t *testing.T) {
	for _, code := range testutil.Locales(t) {
		if _, ok := companyCandidatePrompts[code]; !ok {
			t.Errorf("companyCandidatePrompts missing locale %q", code)
		}
	}
}
