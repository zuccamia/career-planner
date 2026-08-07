package applications

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
)

func init() { testutil.MustLoadPrompts() }

func TestPromptsCoverManifest(t *testing.T) {
	sets := extractJobDescriptionPrompts()
	for _, code := range testutil.Locales(t) {
		if _, ok := sets[code]; !ok {
			t.Errorf("extractJobDescriptionPrompts missing locale %q", code)
		}
	}
}
