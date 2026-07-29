package i18n

import (
	"testing"

	"github.com/zuccamia/career-planner/internal/i18n/testutil"
)

// TestRealManifestLoads guards against listing a locale in manifest.json
// without shipping its bundle file (or shipping a malformed one). Uses the
// checked-in web/static/i18n/, not a fixture — so a broken manifest at rest
// fails CI.
func TestRealManifestLoads(t *testing.T) {
	origDir := bundlesDir
	bundlesDir = testutil.BundlesDir(t)
	bundles = nil
	supported = nil
	t.Cleanup(func() {
		bundlesDir = origDir
		bundles = nil
		supported = nil
	})
	if err := Load(); err != nil {
		t.Fatalf("Load real manifest: %v", err)
	}
	if len(supported) == 0 {
		t.Fatal("supported empty after Load")
	}
	for _, code := range supported {
		if len(bundles[code]) == 0 {
			t.Errorf("bundle %q loaded but has no keys", code)
		}
	}
}
