package companies

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

func init() { testutil.MustLoadPrompts() }

func TestPromptsCoverManifest(t *testing.T) {
	for name, get := range map[string]func() llm.PromptSets{
		"lookupCompanyPrompts": lookupCompanyPrompts,
		"buildDossierPrompts":  buildDossierPrompts,
	} {
		sets := get()
		for _, code := range testutil.Locales(t) {
			if _, ok := sets[code]; !ok {
				t.Errorf("%s missing locale %q", name, code)
			}
		}
	}
}
