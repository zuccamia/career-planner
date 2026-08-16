package discover

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/search"
)

const (
	searchPerHost = 10
	// concurrency 2+ triggers 429s from scraped engines.
	searchConcurrency = 1
	// Higher than one-per-host because each host may retry via the ladder.
	runSearchBudget      = 60
	siteScopedTimeRange  = search.TimeRangeDay
	fallbackAttemptDelay = 500 * time.Millisecond
	// Pause between hosts so scraped engines don't get a burst.
	perHostDelay = 1 * time.Second
	// Once a host's ladder results exceed this, stop broadening.
	perHostResultTarget = 5
)

var (
	defaultSearchCategories = []string{"general"}
	// Free (scraped) engines preferred so paid Brave quota stays untouched.
	freeSearchEngines = []string{"google cse", "bing"}
	paidSearchEngines = []string{"brave-search-api"}
)

// Search returns the site-scoped step's hits grouped per host, shaped like a
// BYOK-search result so BYOK-LLM browsers can own expand + rank while search
// stays on SearXNG.
func (s *Service) Search(ctx context.Context, signals SearchSignals, profile ProfileSummary, locale string) ([]BrowserHitGroup, error) {
	if s.search == nil {
		return nil, fmt.Errorf("server search not configured")
	}
	budget := runSearchBudget
	hosts := atsHosts()
	hits, _ := s.searchHosts(ctx, hosts, signals, profile.Locations, profile.EmploymentType, locale, &budget)
	byBoard := map[string]*BrowserHitGroup{}
	order := []string{}
	for _, h := range hits {
		g, ok := byBoard[h.BoardURL]
		if !ok {
			g = &BrowserHitGroup{
				Host:     strings.TrimPrefix(strings.TrimPrefix(h.BoardURL, "https://"), "http://"),
				Provider: h.Provider,
				BoardURL: h.BoardURL,
			}
			byBoard[h.BoardURL] = g
			order = append(order, h.BoardURL)
		}
		g.Results = append(g.Results, BrowserHitResult{
			URL:         h.URL,
			Title:       h.Title,
			Content:     h.Snippet,
			Engine:      h.Engine,
			PublishedAt: h.PublishedAt,
		})
	}
	out := make([]BrowserHitGroup, 0, len(order))
	for _, k := range order {
		out = append(out, *byBoard[k])
	}
	return out, nil
}

// searchHosts runs the fallback-ladder search per ATS host, deduped by URL.
// Returns accumulated hits and a count of per-host errors.
func (s *Service) searchHosts(
	ctx context.Context,
	hosts []ATSHost,
	signals SearchSignals,
	locations []string,
	employmentType, locale string,
	budget *int,
) ([]SearchHit, int) {
	sem := make(chan struct{}, searchConcurrency)
	var (
		mu      sync.Mutex
		hits    []SearchHit
		errs    int
		wg      sync.WaitGroup
		seenURL = map[string]struct{}{}
	)

	for i, host := range hosts {
		host := host
		isLast := i == len(hosts)-1
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			// Pace between hosts so scraped engines don't get a burst.
			defer func() {
				if !isLast {
					select {
					case <-ctx.Done():
					case <-time.After(perHostDelay):
					}
				}
				<-sem
			}()

			results, err := s.searchHostWithFallbacks(ctx, host, signals, locations, employmentType, locale, &mu, budget)
			if err != nil && len(results) == 0 {
				mu.Lock()
				errs++
				mu.Unlock()
				return
			}

			boardURL := "https://" + host.Host
			mu.Lock()
			defer mu.Unlock()
			for _, r := range results {
				key := normalizeURL(r.URL)
				if key == "" {
					continue
				}
				if _, dup := seenURL[key]; dup {
					continue
				}
				seenURL[key] = struct{}{}
				hits = append(hits, SearchHit{
					URL:         r.URL,
					Title:       r.Title,
					Snippet:     r.Content,
					Engine:      r.Engine,
					PublishedAt: r.PublishedAt,
					BoardURL:    boardURL,
					Provider:    host.Provider,
				})
			}
		}()
	}
	wg.Wait()
	return hits, errs
}

// fallbackAttempt is one rung on the ladder: query shape, freshness filter,
// engine pool. Different rungs may cost-tier engines (free vs paid).
type fallbackAttempt struct {
	query     string
	timeRange string
	engines   []string
}

// buildFallbackQueries assembles the ladder for a single host. Cost-tiered:
// rungs 1-2 use free engines, rung 3 escalates to Brave, rung 4 broadens
// the query (drops signals) with free engines only.
//
// For scarce employment types (internship, new_grad) the ladder uses a
// wider default time_range ("month") since the fresh-daily heuristic
// produces empties for cycle-posted roles.
func buildFallbackQueries(host ATSHost, signals SearchSignals, locations []string, employmentType string) []fallbackAttempt {
	strict := buildSiteScopedQuery(host, signals.RoleVariants, signals.BroadRole, signals.SignalKeywords, locations, employmentType)
	// Broadened query: drop signal keywords (keep role + locations + emp).
	broad := buildSiteScopedQuery(host, signals.RoleVariants, signals.BroadRole, nil, locations, employmentType)
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

// searchHostWithFallbacks walks the ladder for one host, accumulating
// deduped results across rungs. Stops early when the accumulator exceeds
// perHostResultTarget. Consumes one budget unit per rung actually run.
// Returns lastErr only if every rung errored and nothing accumulated.
func (s *Service) searchHostWithFallbacks(
	ctx context.Context,
	host ATSHost,
	signals SearchSignals,
	locations []string,
	employmentType, locale string,
	mu *sync.Mutex,
	budget *int,
) ([]search.Result, error) {
	attempts := buildFallbackQueries(host, signals, locations, employmentType)
	seenQuery := map[string]struct{}{}
	seenURL := map[string]struct{}{}
	accum := []search.Result{}
	var lastErr error
	for i, a := range attempts {
		if a.query == "" {
			continue
		}
		// Dedupe key includes engines so rungs with the same (query,
		// time_range) but different engine pools don't collapse.
		key := a.query + "|" + a.timeRange + "|" + strings.Join(a.engines, ",")
		if _, ok := seenQuery[key]; ok {
			continue
		}
		seenQuery[key] = struct{}{}
		mu.Lock()
		if *budget <= 0 {
			mu.Unlock()
			break
		}
		*budget--
		mu.Unlock()
		if i > 0 {
			select {
			case <-ctx.Done():
				return accum, ctx.Err()
			case <-time.After(fallbackAttemptDelay):
			}
		}
		results, err := s.search.Search(ctx, a.query, search.Options{
			Limit:      searchPerHost,
			Categories: defaultSearchCategories,
			Engines:    a.engines,
			Language:   locale,
			TimeRange:  a.timeRange,
		})
		if err != nil {
			lastErr = err
			log.Printf("discover: host=%s attempt=%d failed: %v", host.Host, i+1, err)
			continue
		}
		engineNames := make([]string, len(results))
		for i, r := range results {
			engineNames[i] = r.Engine
		}
		log.Printf("discover: host=%s attempt=%d asked=%s time_range=%q results=%d hits=%s q=%q",
			host.Host, i+1, strings.Join(a.engines, "+"), a.timeRange, len(results), formatEngineCounts(engineNames), a.query)
		accum = append(accum, filterNewBy(seenURL, results, func(r search.Result) string { return normalizeURL(r.URL) })...)
		if len(accum) > perHostResultTarget {
			return accum, nil
		}
	}
	if len(accum) > 0 {
		return accum, nil
	}
	return nil, lastErr
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
