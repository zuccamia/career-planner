package discover

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/ats"
)

// --- goneCache ------------------------------------------------------

// Concurrent Add/Has must be race-free and the cap must hold.
func TestGoneCache_Concurrent(t *testing.T) {
	c := newGoneCache()
	const workers, perWorker = 20, 50
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		w := w
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				u := fmt.Sprintf("https://example.com/jobs/%d-%d", w, i)
				c.Add(u)
				_ = c.Has(u)
			}
		}()
	}
	wg.Wait()

	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.order) != len(c.seen) {
		t.Errorf("order/seen desync: %d/%d", len(c.order), len(c.seen))
	}
	if len(c.order) > goneCacheCap {
		t.Errorf("cap exceeded: len=%d cap=%d", len(c.order), goneCacheCap)
	}
}

// Nil-receiver methods must no-op, not panic.
func TestGoneCache_NilSafe(t *testing.T) {
	var c *goneCache
	c.Add("https://example.com/x")
	if c.Has("https://example.com/x") {
		t.Error("nil goneCache.Has must return false")
	}
}

// --- probeSPADeadPage -----------------------------------------------

// Host without registered markers → short-circuits, no network.
// Pointing at an unroutable URL would hang if the probe tried to dial.
func TestProbeDeadMarkers_UnregisteredHost(t *testing.T) {
	loadProvidersForTestDefaults(t)
	isDead, err := probeSPADeadPage(context.Background(), "https://jobs.lever.co/co/1")
	if err != nil || isDead {
		t.Errorf("unregistered host should short-circuit: dead=%v err=%v", isDead, err)
	}
}

func TestProbeDeadMarkers_MarkerPresent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<meta name="twitter:url" content="https://x/results/undefined">`))
	}))
	defer server.Close()
	withStubMarker(t, server.URL, "results/undefined")

	isDead, err := probeSPADeadPage(context.Background(), server.URL+"/some/path")
	if err != nil || !isDead {
		t.Errorf("expected marker detected: dead=%v err=%v", isDead, err)
	}
}

func TestProbeDeadMarkers_MarkerAbsent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<html><head><title>Live job</title></head></html>`))
	}))
	defer server.Close()
	withStubMarker(t, server.URL, "results/undefined")

	isDead, err := probeSPADeadPage(context.Background(), server.URL+"/some/path")
	if err != nil || isDead {
		t.Errorf("marker absent — probe should not drop: dead=%v err=%v", isDead, err)
	}
}

// --- helpers --------------------------------------------------------

// loadProvidersForTestDefaults loads the shipped ats-providers.json.
func loadProvidersForTestDefaults(t *testing.T) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	if err := ats.LoadProviders(filepath.Join(root, "web", "static", "data")); err != nil {
		t.Fatalf("LoadProviders: %v", err)
	}
}

// withStubMarker rewrites the providers config so serverURL's host has
// the given dead_marker registered, and restores defaults on cleanup.
func withStubMarker(t *testing.T, serverURL, marker string) {
	t.Helper()
	host := hostOf(serverURL)
	cfg := `[{"provider":"test","search_hosts":["` + host +
		`"],"host_pattern":"^` + host + `$","slug_in_path":false,"dead_markers":["` + marker + `"]}]`
	tmpDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpDir, "ats-providers.json"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("write providers.json: %v", err)
	}
	if err := ats.LoadProviders(tmpDir); err != nil {
		t.Fatalf("LoadProviders(tmp): %v", err)
	}
	t.Cleanup(func() { loadProvidersForTestDefaults(t) })
}

// hostOf mirrors url.URL.Hostname() — strip scheme + port.
func hostOf(rawURL string) string {
	i := strings.Index(rawURL, "://")
	if i < 0 {
		return rawURL
	}
	rest := rawURL[i+3:]
	if s := strings.Index(rest, "/"); s >= 0 {
		rest = rest[:s]
	}
	if c := strings.Index(rest, ":"); c >= 0 {
		rest = rest[:c]
	}
	return rest
}
