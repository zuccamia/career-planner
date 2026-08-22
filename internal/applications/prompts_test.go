package applications

import (
	"strings"
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

// TestRoleSignalsHeadingsCoherent guards a fragile cross-prompt coupling:
// analyze-role-signals emits four H3 sections in `signals`, and rank/tailor
// downstream match `signals_hit` / `citations` as verbatim substrings of
// those bullets. A locale-only rename of a heading would silently break the
// downstream matching. Pin the four headings per locale here.
func TestRoleSignalsHeadingsCoherent(t *testing.T) {
	// Per-locale expected H3 headings, in the order the analyze prompt emits.
	expected := map[string][]string{
		"en": {"### Desirable skills", "### Desirable traits", "### Stories that would resonate", "### Notes"},
		"vi": {"### Kỹ năng cần có", "### Phẩm chất cần có", "### Dạng câu chuyện phù hợp", "### Ghi chú"},
	}
	analyze := analyzeRoleSignalsPrompts()
	rank := tailorRankBragsPrompts()
	tailor := tailorDraftResumePrompts()
	for locale, headings := range expected {
		for _, h := range headings {
			if !strings.Contains(analyze[locale].User, h) {
				t.Errorf("%s analyze-role-signals: missing heading %q", locale, h)
			}
		}
		// rank + tailor prompts reference the first three headings (Notes is
		// excluded per the verbatim-substring rule). Assert those show up.
		for _, h := range headings[:3] {
			if !strings.Contains(rank[locale].User, h) {
				t.Errorf("%s tailor-rank-brags: missing referenced heading %q", locale, h)
			}
			if !strings.Contains(tailor[locale].User, h) {
				t.Errorf("%s tailor-draft-resume: missing referenced heading %q", locale, h)
			}
		}
	}
}
