package discover

// Cross-file utilities: rune-safe truncation, URL normalization, HTTP
// status probe + dead-link filter, and a small generic dedup filter.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/sources/search"
)

// ---- request/response normalization ----

// normalizeRequest trims + length-caps every free-text field on the request.
func normalizeRequest(req DiscoverRequest) DiscoverRequest {
	req.Profile.Headline = truncate(strings.TrimSpace(req.Profile.Headline), capHeadline)
	req.Profile.Summary = truncate(strings.TrimSpace(req.Profile.Summary), capSummary)
	req.Profile.Skills = capStringSlice(req.Profile.Skills, capSkillName, capSkills)
	req.Profile.Locations = capStringSlice(req.Profile.Locations, capLocationName, capLocations)
	req.Profile.EmploymentType = strings.TrimSpace(req.Profile.EmploymentType)

	if len(req.Companies) > capCompanies {
		req.Companies = req.Companies[:capCompanies]
	}
	for i, c := range req.Companies {
		req.Companies[i] = SeedCompany{
			Name: truncate(strings.TrimSpace(c.Name), capCompanyName),
		}
	}

	if len(req.Applications) > capApplications {
		req.Applications = req.Applications[:capApplications]
	}
	for i, a := range req.Applications {
		req.Applications[i] = ExistingApplication{
			JobURL: truncate(strings.TrimSpace(a.JobURL), capJobURL),
		}
	}

	req.ExcludeURLs = capStringSlice(req.ExcludeURLs, capJobURL, capExcludeURLs)

	req.BragTitles = capStringSlice(req.BragTitles, capBragTitle, capBragTitles)
	req.CareerSparks = capStringSlice(req.CareerSparks, capCareerSpark, capCareerSparks)
	return req
}

// capStringSlice trims + truncates each entry, drops empties, caps length.
func capStringSlice(in []string, perElement, limit int) []string {
	if len(in) == 0 {
		return in
	}
	out := make([]string, 0, len(in))
	for _, s := range in {
		v := truncate(strings.TrimSpace(s), perElement)
		if v == "" {
			continue
		}
		out = append(out, v)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// collectBrowserHits flattens per-host BYOK results into SearchHits, deduped by URL.
func collectBrowserHits(groups []BrowserHitGroup) []SearchHit {
	seen := map[string]struct{}{}
	out := make([]SearchHit, 0, 32)
	for _, g := range groups {
		for _, r := range g.Results {
			key := normalizeURL(r.URL)
			if key == "" {
				continue
			}
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, SearchHit{
				URL:         r.URL,
				Title:       r.Title,
				Snippet:     r.Content,
				Engine:      r.Engine,
				PublishedAt: r.PublishedAt,
				BoardURL:    g.BoardURL,
				Provider:    g.Provider,
			})
		}
	}
	return out
}

// listExistingURLs returns the normalized-URL set of already-tracked applications.
func listExistingURLs(apps []ExistingApplication) map[string]struct{} {
	out := make(map[string]struct{}, len(apps))
	for _, a := range apps {
		if key := normalizeURL(a.JobURL); key != "" {
			out[key] = struct{}{}
		}
	}
	return out
}

// filterStalePostings drops postings older than the employment-type budget.
// Zero PostedAt passes through — some ATS providers don't stamp postings.
func filterStalePostings(postings []JobPosting, employmentType string) []JobPosting {
	maxAge := staleDefaultDays
	if isScarceEmployment(employmentType) {
		maxAge = staleScarceDays
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -maxAge)
	// Reuse postings' backing array; postings is not read again after this loop.
	out := postings[:0]
	for _, p := range postings {
		if p.PostedAt != nil && p.PostedAt.Before(cutoff) {
			continue
		}
		out = append(out, p)
	}
	return out
}

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

// ---- expand-query helpers ----

// applyHeadlineFallback ensures RoleVariants is non-empty by falling back to
// the profile headline. The LLM's job is to broaden recall; if it whiffed,
// the headline alone still points search somewhere.
func applyHeadlineFallback(query SearchQuery, headline string) SearchQuery {
	if len(query.RoleVariants) == 0 {
		if h := strings.TrimSpace(headline); h != "" {
			query.RoleVariants = []string{h}
		}
	}
	return query
}

// ---- query construction ----

// seasonalYears returns the year of targetHireMonth. Aug 2026 → May 2027
// → year 2027 — the cycle the user would actually start if applied now.
func seasonalYears() []string {
	return []string{strconv.Itoa(targetHireMonth().Year())}
}

// buildSiteScopedQuery composes: site:{host} (roleGroup) (signalGroup)
// (locationGroup) (empGroup). Empty groups are dropped. OR is uppercase
// (Google requires it); space-separated groups AND implicitly.
//
// For scarce employment types (internship, new_grad), roles collapse to a
// single broader term (`broadRole`, or first variant as fallback) and
// signal keywords are dropped — the specific-variant + signal narrowing
// prunes the small pool to zero.
func buildSiteScopedQuery(host ATSHost, roles []string, broadRole string, signals, locations []string, employmentType string) string {
	if host.Host == "" {
		return ""
	}
	if isScarceEmployment(employmentType) {
		if broadRole != "" {
			roles = []string{broadRole}
		} else if len(roles) > 0 {
			roles = roles[:1]
		}
		signals = nil
	}
	parts := []string{"site:" + host.Host}
	groups := [][]string{roles, signals, locations, employmentTitleKeywords[employmentType]}
	// Scarce (cycle-driven) roles: also constrain to the current+next
	// year. Fresh internship/new-grad postings virtually always name the
	// cycle year in the title or body; timeless-looking ones are usually
	// evergreen stubs or stale.
	if isScarceEmployment(employmentType) {
		groups = append(groups, seasonalYears())
	}
	for _, group := range groups {
		if g := composeORGroup(group); g != "" {
			parts = append(parts, g)
		}
	}
	return strings.Join(parts, " ")
}

// buildFallbackQueries assembles the ladder for a single host. Cost-tiered:
// rungs 1-2 use free engines, rung 3 escalates to Brave, rung 4 broadens
// the query (drops signals) with free engines only.
//
// For scarce employment types (internship, new_grad) the ladder uses a
// wider default time_range ("month") since the fresh-daily heuristic
// produces empties for cycle-posted roles.
func buildFallbackQueries(host ATSHost, query SearchQuery, locations []string, employmentType string) []fallbackAttempt {
	strict := buildSiteScopedQuery(host, query.RoleVariants, query.BroadRole, query.SignalKeywords, locations, employmentType)
	// Broadened query: drop signal keywords (keep role + locations + emp).
	broad := buildSiteScopedQuery(host, query.RoleVariants, query.BroadRole, nil, locations, employmentType)
	freshRange := siteScopedTimeRange
	if isScarceEmployment(employmentType) {
		freshRange = search.TimeRangeMonth
	}
	return []fallbackAttempt{
		{strict, freshRange, freeSearchEngines},
		{strict, "", freeSearchEngines},
		{strict, freshRange, paidSearchEngines},
		{broad, freshRange, freeSearchEngines},
	}
}

// ---- keyword / query utilities ----

func sanitizeKeywords(in []string, limit int) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, v := range in {
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, llm.SanitizeText(trimmed))
		if len(out) >= limit {
			break
		}
	}
	return out
}

// composeORGroup formats a term list as a Google-search OR group. One term
// returns `"term"`; multiple returns `("t1" OR "t2" OR ...)`. Empty input
// returns "". Dedupes case-insensitively. Terms are quoted so multi-word
// phrases stay intact.
func composeORGroup(terms []string) string {
	quoted := make([]string, 0, len(terms))
	seen := map[string]struct{}{}
	for _, v := range terms {
		s := strings.TrimSpace(v)
		if s == "" {
			continue
		}
		key := strings.ToLower(s)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		quoted = append(quoted, `"`+s+`"`)
	}
	if len(quoted) == 0 {
		return ""
	}
	if len(quoted) == 1 {
		return quoted[0]
	}
	return "(" + strings.Join(quoted, " OR ") + ")"
}

// formatEngineCounts tallies occurrences per name, sorted descending.
// Example: names=["bing","brave","bing"] → "bing=2,brave=1".
func formatEngineCounts(names []string) string {
	if len(names) == 0 {
		return "-"
	}
	counts := map[string]int{}
	for _, n := range names {
		if n == "" {
			n = "?"
		}
		counts[n]++
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if counts[keys[i]] != counts[keys[j]] {
			return counts[keys[i]] > counts[keys[j]]
		}
		return keys[i] < keys[j]
	})
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, counts[k]))
	}
	return strings.Join(parts, ",")
}

// ---- posting utilities ----

// capPostings returns a copy of postings with prompt-visible fields truncated.
// json:"-" fields (BoardURL, Provider, PostedAt) don't enter the prompt.
func capPostings(in []JobPosting) []JobPosting {
	out := make([]JobPosting, len(in))
	for i, p := range in {
		p.Title = truncate(p.Title, capPostingTitle)
		p.Snippet = truncate(p.Snippet, capPostingSnippet)
		p.Company = truncate(p.Company, capPostingCompany)
		out[i] = p
	}
	return out
}

// companyFromURL derives a display name from the URL's tenant slug for
// slug_in_path providers when structured extraction and the LLM both leave
// Company empty. Non-slug_in_path hosts don't get a URL-based guess — that
// used to fire wrong labels for Workday/Google/MS/internal-ATS URLs; those
// paths return "" and let the LLM or the user's own edit fill it in.
func companyFromURL(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Hostname() == "" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	_, slugInPath, ok := ats.LookupHost(host)
	if !ok || !slugInPath {
		return ""
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	return ats.PrettifySlug(parts[0])
}
