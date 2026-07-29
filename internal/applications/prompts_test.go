package applications

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
)

func TestPromptsCoverManifest(t *testing.T) {
	for _, code := range testutil.Locales(t) {
		if _, ok := extractJobDescriptionPrompts[code]; !ok {
			t.Errorf("extractJobDescriptionPrompts missing locale %q", code)
		}
	}
}
