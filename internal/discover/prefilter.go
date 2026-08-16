package discover

// Avoid-wasted-work drops. preFilterHits screens raw hits; goneCache
// memoizes 404s across Runs in a process; probeSPADeadPage body-scans
// SPAs whose dead pages return 200.

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/ats"
)

// goneCached = prior-run 404s (via goneCache). Extract-time gone_new is
// tracked separately. pastCycle = URL slug names a stale season/year.
type preFilterCounts struct {
	dedupe     int
	shape      int
	goneCached int
	pastCycle  int
}

func preFilterHits(
	hits []SearchHit,
	existing map[string]struct{},
	ats ATSPreFilter,
	gone *goneCache,
) ([]SearchHit, preFilterCounts) {
	if len(hits) == 0 {
		return hits, preFilterCounts{}
	}
	var counts preFilterCounts
	out := make([]SearchHit, 0, len(hits))
	for _, h := range hits {
		key := normalizeURL(h.URL)
		if key == "" {
			continue
		}
		if _, dup := existing[key]; dup {
			counts.dedupe++
			continue
		}
		if ats != nil && ats.IsLandingPage(h.URL) {
			counts.shape++
			continue
		}
		if gone.Has(h.URL) {
			counts.goneCached++
			continue
		}
		if isPastCycle(h.URL + " " + h.Title) {
			counts.pastCycle++
			continue
		}
		out = append(out, h)
	}
	return out, counts
}

// ATSPreFilter is the subset of ats.Registry the pre-filter needs.
type ATSPreFilter interface {
	IsLandingPage(rawURL string) bool
}

// FIFO evict-half on overflow — dead URLs don't get re-checked.
const goneCacheCap = 256

type goneCache struct {
	mu    sync.Mutex
	seen  map[string]struct{}
	order []string
}

func newGoneCache() *goneCache {
	return &goneCache{seen: make(map[string]struct{}, goneCacheCap)}
}

func (c *goneCache) Add(url string) {
	if c == nil {
		return
	}
	key := normalizeURL(url)
	if key == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, dup := c.seen[key]; dup {
		return
	}
	if len(c.order) >= goneCacheCap {
		half := len(c.order) / 2
		for _, k := range c.order[:half] {
			delete(c.seen, k)
		}
		c.order = c.order[half:]
	}
	c.seen[key] = struct{}{}
	c.order = append(c.order, key)
}

func (c *goneCache) Has(url string) bool {
	if c == nil {
		return false
	}
	key := normalizeURL(url)
	if key == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.seen[key]
	return ok
}

const (
	deadProbeTimeout = 3 * time.Second
	deadProbeBodyCap = 100 << 10 // markers live in <head>; 100KB is plenty
)

// probeSPADeadPage returns true when the host has dead_markers registered
// in ats-providers.json and the response body contains one. Short-circuits
// with zero network cost when no markers apply. Best-effort — GET errors
// keep the URL.
func probeSPADeadPage(ctx context.Context, rawURL string) (bool, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Hostname() == "" {
		return false, nil
	}
	markers := ats.DeadMarkersForHost(strings.ToLower(u.Hostname()))
	if len(markers) == 0 {
		return false, nil
	}
	client := &http.Client{Timeout: deadProbeTimeout}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; career-planner-discover/1.0)")
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, deadProbeBodyCap))
	if err != nil {
		return false, err
	}
	s := string(body)
	for _, m := range markers {
		if strings.Contains(s, m) {
			return true, nil
		}
	}
	return false, nil
}
