package dossiers

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
)

func TestPromptsCoverManifest(t *testing.T) {
	for _, code := range testutil.Locales(t) {
		if _, ok := dossierPrompts[code]; !ok {
			t.Errorf("dossierPrompts missing locale %q", code)
		}
	}
}
