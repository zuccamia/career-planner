package discover

// Cross-file utilities: rune-safe truncation, URL normalization, HTTP
// status probe + dead-link filter, and a small generic dedup filter.

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/ats"
)

// atsHosts returns the search targets loaded from ats-providers.json.
func atsHosts() []ATSHost { return ats.SearchHosts() }

// truncate clips s to at most n bytes without splitting a UTF-8 rune. When n
// falls mid-rune, we back up to the previous rune boundary — safer for JSON
// prompts, where a chopped multibyte tail becomes U+FFFD.
func truncate(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	for n > 0 && (s[n]&0xC0) == 0x80 {
		n--
	}
	return s[:n]
}

// normalizeURL returns a stable dedup key: registrable-domain host (last
// two labels — collapses subdomain drift), lowercased scheme, query
// dropped, fragment stripped, trailing slash trimmed. Query is dropped
// wholesale — every job board we support identifies the posting via
// path; query is always tracking (gh_jid, utm_*, ref, session tokens).
// Malformed input → trimmed lowercase original.
func normalizeURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" {
		return strings.ToLower(trimmed)
	}
	host := strings.ToLower(u.Host)
	if labels := strings.Split(host, "."); len(labels) >= 2 {
		host = labels[len(labels)-2] + "." + labels[len(labels)-1]
	}
	u.Host = host
	u.Scheme = strings.ToLower(u.Scheme)
	u.Fragment = ""
	u.RawQuery = ""
	if u.Path == "" {
		u.Path = "/"
	}
	if len(u.Path) > 1 {
		u.Path = strings.TrimRight(u.Path, "/")
	}
	return u.String()
}

// employmentTitleKeywords maps a `looking_for` value to a small OR-group of
// title-frequency variants Google/Bing typically see in real posting titles.
// Only cycle-driven types (internship, new-grad) have entries — for
// full_time / contract / open the modifier rarely appears in titles, so
// adding it as a title-word filter would over-narrow results.
var employmentTitleKeywords = map[string][]string{
	"internship": {"intern", "internship", "co-op"},
	"new_grad":   {"new grad", "new graduate", "entry level"},
}

// isScarceEmployment reports whether the role's posting pool is small and
// cycle-driven. Callers loosen behavior for these types (wider staleness
// window, broader query, longer time_range). Derived from the same map by
// coincidence: every scarce role also has a title-frequency expansion.
func isScarceEmployment(employmentType string) bool {
	_, ok := employmentTitleKeywords[employmentType]
	return ok
}

// --- time anchors --------------------------------------------------

// nowLocal is a package var so tests can freeze time. Local (not UTC)
// so the year window matches the user's calendar.
var nowLocal = func() time.Time { return time.Now() }

// targetHireMonth: nominal "when hiring should land" — now + 9 months.
// Anchor for seasonalYears (search query) and isPastCycleURL (pre-filter).
func targetHireMonth() time.Time { return nowLocal().AddDate(0, 9, 0) }

// --- past-cycle heuristic ------------------------------------------

// isolatedYear matches a 20xx year with non-digit boundaries. Works for
// URL slugs ("-summer-2026-") and titles ("Intern (Summer 2026)"); job
// IDs like "/7863909" and internal digits like "20264HR" don't match.
var isolatedYear = regexp.MustCompile(`(?:^|\D)(20\d{2})(?:\D|$)`)

// isPastCycle: max isolated year in text is earlier than the target hire
// year. Anchored on targetHireMonth so search and filter agree. Callers
// concatenate URL + Title so the check catches postings that leak the
// cycle in either place.
func isPastCycle(text string) bool {
	maxYear := 0
	for _, m := range isolatedYear.FindAllStringSubmatch(text, -1) {
		if y, err := strconv.Atoi(m[1]); err == nil && y > maxYear {
			maxYear = y
		}
	}
	return maxYear > 0 && maxYear < targetHireMonth().Year()
}

// filterNewBy returns items whose key isn't already in `seen`. Mutates
// `seen` to include the returned items' keys so successive calls skip
// them. Generic on keyOf so the helper doesn't couple to any item type.
func filterNewBy[T any](seen map[string]struct{}, items []T, keyOf func(T) string) []T {
	out := make([]T, 0, len(items))
	for _, item := range items {
		key := keyOf(item)
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}

// --- HTTP status probe + dead-link filter ---------------------------

const headCheckTimeout = 3 * time.Second

// httpStatusProbe is a package var so tests can inject a stub.
// Returns (isDead, reason); reason identifies which dead signal fired.
var httpStatusProbe = probeHTTPStatus

// filterDeadLinks HEAD-checks recs in parallel, drops any confirmed dead,
// and (when gone is non-nil) writes them to the cache. Best-effort —
// transient errors keep the rec.
func filterDeadLinks(ctx context.Context, recs []Recommendation, gone *goneCache) []Recommendation {
	if len(recs) == 0 {
		return recs
	}
	client := &http.Client{Timeout: headCheckTimeout}
	type probeResult struct {
		dead   bool
		reason string
	}
	results := make([]probeResult, len(recs))
	var wg sync.WaitGroup
	for i, r := range recs {
		i, url := i, r.URL
		wg.Add(1)
		go func() {
			defer wg.Done()
			dead, reason := httpStatusProbe(ctx, client, url)
			results[i] = probeResult{dead: dead, reason: reason}
		}()
	}
	wg.Wait()
	// Reuse recs' backing array; recs is not read again after this loop.
	out := recs[:0]
	for i, r := range recs {
		if !results[i].dead {
			out = append(out, r)
			continue
		}
		log.Printf("discover: dropped dead-link rec reason=%s url=%s", results[i].reason, r.URL)
		gone.Add(r.URL)
	}
	return out
}

// Drop reasons — short slugs for consistent log grepping.
const (
	deadReasonUnparseable = "unparseable-url"
	deadReasonHTTPStatus  = "status-4xx" // 404 or 410
	deadReasonCareersHome = "redirect-to-careers-home"
)

// probeHTTPStatus returns (true, reason) on a deterministic dead signal:
// unparseable URL, 404/410, or redirect to a careers landing. Transient
// signals (network err, 405, 5xx) return (false, "").
func probeHTTPStatus(ctx context.Context, client *http.Client, rawURL string) (bool, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, rawURL, nil)
	if err != nil {
		return true, deadReasonUnparseable
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; career-planner-discover/1.0)")
	resp, err := client.Do(req)
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return true, deadReasonHTTPStatus
	}
	// Final URL after redirect-follow — dead-end path means the ATS
	// redirected a closed posting to its tenant home.
	if resp.Request != nil && resp.Request.URL != nil {
		if redirectedToCareersHome(rawURL, resp.Request.URL.String()) {
			return true, deadReasonCareersHome
		}
	}
	return false, ""
}

// deadEndPaths: tenant careers pages that catch unknown-job-id traffic.
var deadEndPaths = map[string]struct{}{
	"":          {},
	"/":         {},
	"/careers":  {},
	"/jobs":     {},
	"/openings": {},
	"/roles":    {},
	"/search":   {},
}

// redirectedToCareersHome: final URL differs AND its path is in
// deadEndPaths. Host-agnostic — cross-host redirect to a dead-end path
// still indicates a removed posting.
func redirectedToCareersHome(originalURL, finalURL string) bool {
	if originalURL == finalURL {
		return false
	}
	final, err := url.Parse(finalURL)
	if err != nil {
		return false
	}
	trimmed := strings.TrimRight(final.Path, "/")
	_, dead := deadEndPaths[trimmed]
	return dead
}
