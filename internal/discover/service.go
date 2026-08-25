package discover

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
	"github.com/zuccamia/career-planner/internal/sources/search"
	"github.com/zuccamia/career-planner/internal/util"
)

// ---- service ----

// Service orchestrates the discovery pipeline: LLM signal extraction →
// site-scoped search across a fixed ATS host list → extraction → URL
// dedupe → LLM rank.
type Service struct {
	llm    llm.Client
	search search.Client
	scrape scrape.Client
	ats    ATSFetcher
	gone   *goneCache // process-lifetime
}

// NewService always returns a non-nil Service so callers (byok prompt/parse
// endpoints, Discover UI status probes) don't need nil-guards. Missing LLM
// or search is reported by CanRunServerPipeline, and Run degrades gracefully
// when the caller doesn't supply browser-side substitutes.
func NewService(llmClient llm.Client, searchClient search.Client, scrapeClient scrape.Client, atsReg ATSFetcher) *Service {
	return &Service{
		llm:    llmClient,
		search: searchClient,
		scrape: scrapeClient,
		ats:    atsReg,
		gone:   newGoneCache(),
	}
}

// CanRunServerPipeline reports whether the fully server-side Discover flow
// can execute end-to-end (server LLM + server search both configured). BYOK
// paths that ship browser-computed Signals/Hits can succeed even when this
// returns false.
func (s *Service) CanRunServerPipeline() bool {
	return s.llm != nil && s.search != nil
}

// ---- run ----

// Run drives the pipeline end-to-end. The response's Diagnostics field
// explains any empty result. Errors are reserved for genuine failures
// (LLM/HTTP) — expected empty outcomes return (DiscoverResponse, nil).
func (s *Service) Run(ctx context.Context, req DiscoverRequest) (DiscoverResponse, error) {
	req = normalizeRequest(req)
	limit := req.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}

	// Empty headline: the site-scoped search would have no role query to
	// run. Short-circuit before spending any LLM tokens.
	if strings.TrimSpace(req.Profile.Headline) == "" {
		return DiscoverResponse{
			Diagnostics: []string{i18n.T(req.Locale, "discover.diagnostic.missing_headline")},
		}, nil
	}

	// Capability check: server LLM is required (expand + rank), and server
	// search is required unless the caller pre-computed BrowserHits.
	if s.llm == nil {
		return DiscoverResponse{
			Diagnostics: []string{i18n.T(req.Locale, "discover.diagnostic.server_llm_missing")},
		}, nil
	}
	if s.search == nil && len(req.BrowserHits) == 0 {
		return DiscoverResponse{
			Diagnostics: []string{i18n.T(req.Locale, "discover.diagnostic.server_search_missing")},
		}, nil
	}

	diagnostics := []string{}
	budget := runSearchBudget

	// Step 1 — LLM derives role variants + signal keywords from the profile.
	// expandQuery falls back to the raw headline when the LLM whiffs.
	query, err := s.expandQuery(ctx, req)
	if err != nil {
		return DiscoverResponse{}, fmt.Errorf("expand query: %w", err)
	}

	// Step 2 — site-scoped search across every ATS host. Skipped when the
	// browser fetched results itself via BYOK search (Tavily / Brave); those
	// arrive on req.BrowserHits already deduped per host.
	hosts := atsHosts()
	var hits []SearchHit
	var hitErrs int
	if len(req.BrowserHits) > 0 {
		hits = collectBrowserHits(req.BrowserHits)
	} else {
		hits, hitErrs = s.searchHosts(ctx, hosts, query, req.Profile.Locations, req.Profile.EmploymentType, req.Locale, &budget)
	}
	rawHits := len(hits)
	if rawHits == 0 {
		if hitErrs > 0 {
			diagnostics = append(diagnostics, i18n.T(req.Locale, "discover.diagnostic.all_searches_failed"))
		} else {
			diagnostics = append(diagnostics, i18n.T(req.Locale, "discover.diagnostic.no_hits"))
		}
		s.logRun(0, len(hosts), 0, preFilterCounts{}, 0, 0, 0, 0)
		return DiscoverResponse{Diagnostics: diagnostics}, nil
	}

	// Step 2b — pre-extract triage: dedupe / landing-page shape / gone
	// cache. Reclaims budget slots before extract.
	existing := listExistingURLs(req.Applications)
	for _, u := range req.ExcludeURLs {
		if key := normalizeURL(u); key != "" {
			existing[key] = struct{}{}
		}
	}
	hits, preCounts := preFilterHits(hits, existing, s.ats, s.gone)
	if len(hits) == 0 {
		// Tracked-URL is the overwhelmingly common reason; the other
		// two drops (shape, gone) still point the user at "your list
		// is blanketing the search".
		diagnostics = append(diagnostics, i18n.T(req.Locale, "discover.diagnostic.all_tracked"))
		s.logRun(0, len(hosts), rawHits, preCounts, 0, 0, 0, 0)
		return DiscoverResponse{Diagnostics: diagnostics}, nil
	}

	// Step 3 — extract postings (ATS-first). ErrPostingNotFound URLs go
	// to s.gone; other failures fall through with the search snippet.
	postings, goneNew := extractPostings(ctx, hits, s.ats, s.gone, extractBudget)
	if len(postings) == 0 {
		diagnostics = append(diagnostics, i18n.T(req.Locale, "discover.diagnostic.all_gone"))
		s.logRun(0, len(hosts), rawHits, preCounts, goneNew, 0, 0, 0)
		return DiscoverResponse{Diagnostics: diagnostics}, nil
	}

	// Step 4b — freshness filter. Search-engine time_range is unreliable
	// (Brave's past_day uses its own indexing date, not the posting's
	// PostedAt). Now that ATS providers populate PostedAt, drop postings
	// older than the age budget for this employment type. Postings with
	// zero PostedAt (unknown) pass through — better to over-include than
	// silently drop a valid recent posting.
	postings = filterStalePostings(postings, req.Profile.EmploymentType)
	if len(postings) == 0 {
		diagnostics = append(diagnostics, i18n.T(req.Locale, "discover.diagnostic.all_stale"))
		s.logRun(0, len(hosts), rawHits, preCounts, goneNew, 0, 0, 0)
		return DiscoverResponse{Diagnostics: diagnostics}, nil
	}

	// Step 5 — LLM ranks the survivors.
	recs, err := s.rankPostings(ctx, req, postings, limit)
	if err != nil {
		return DiscoverResponse{}, fmt.Errorf("rank postings: %w", err)
	}
	ranked := len(recs)
	// Step 5b — HEAD-check final recs so a 404 doesn't make it to the UI.
	// Best-effort; if the HEAD errors (timeout, blocked) we keep the rec.
	// Any URL the check confirms dead also feeds s.gone so the next Run
	// skips it at pre-filter.
	recs = filterDeadLinks(ctx, recs, s.gone)
	s.logRun(1, len(hosts), rawHits, preCounts, goneNew, len(postings), ranked, len(recs))
	return DiscoverResponse{
		Recommendations: recs,
		Diagnostics:     diagnostics,
	}, nil
}

// ---- logging ----

// logRun emits one structured diagnostic line per Run.
//   - rankAttempts: 0 = early-exit, 1 = ranker was called.
//   - pre_*: dropped by pre-filter (tracked / landing / cached-gone / past-cycle).
//   - gone_new: 404'd for the first time this Run; also written to the cache.
//   - ranked − recs: how many the HEAD dead-link filter killed.
func (s *Service) logRun(rankAttempts, hosts, hits int, pre preFilterCounts, goneNew, postings, ranked, recs int) {
	log.Printf("discover: rankAttempts=%d hosts=%d hits=%d pre_dedupe=%d pre_shape=%d gone_cached=%d past_cycle=%d gone_new=%d postings=%d ranked=%d recs=%d",
		rankAttempts, hosts, hits, pre.dedupe, pre.shape, pre.goneCached, pre.pastCycle, goneNew, postings, ranked, recs)
}

// ---- expand-query ----

func (s *Service) expandQuery(ctx context.Context, req DiscoverRequest) (SearchQuery, error) {
	seedNames := make([]string, 0, len(req.Companies))
	for _, c := range req.Companies {
		if name := strings.TrimSpace(c.Name); name != "" {
			seedNames = append(seedNames, name)
		}
	}
	blob, err := json.Marshal(expandContext{
		Profile:        req.Profile,
		SeedCompanies:  seedNames,
		BragTitles:     req.BragTitles,
		CareerSparks:   req.CareerSparks,
		EmploymentType: strings.TrimSpace(req.Profile.EmploymentType),
		Location:       deriveLocationContext(req.Profile.Locations),
	})
	if err != nil {
		return SearchQuery{}, fmt.Errorf("marshal expand context: %w", err)
	}
	set := llm.PickPromptSet(expandQueryPrompts(), req.Locale)
	prompt := llm.Prompt{System: set.System, User: fmt.Sprintf(set.User, string(blob))}
	var out expandResponse
	if err := s.llm.GenerateJSON(ctx, prompt, &out); err != nil {
		return SearchQuery{}, fmt.Errorf("expand-query llm: %w", err)
	}
	return applyHeadlineFallback(out.toQuery(), req.Profile.Headline), nil
}

// ---- search ----

// Search returns the site-scoped step's hits grouped per host, shaped like a
// BYOK-search result so BYOK-LLM browsers can own expand + rank while search
// stays on SearXNG.
func (s *Service) Search(ctx context.Context, query SearchQuery, profile ProfileSummary, locale string) ([]BrowserHitGroup, error) {
	if s.search == nil {
		return nil, fmt.Errorf("server search not configured")
	}
	budget := runSearchBudget
	hosts := atsHosts()
	hits, _ := s.searchHosts(ctx, hosts, query, profile.Locations, profile.EmploymentType, locale, &budget)
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
	query SearchQuery,
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

			results, err := s.searchHostWithFallbacks(ctx, host, query, locations, employmentType, locale, &mu, budget)
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

// searchHostWithFallbacks walks the ladder for one host, accumulating
// deduped results across rungs. Stops early when the accumulator exceeds
// perHostResultTarget. Consumes one budget unit per rung actually run.
// Returns lastErr only if every rung errored and nothing accumulated.
func (s *Service) searchHostWithFallbacks(
	ctx context.Context,
	host ATSHost,
	query SearchQuery,
	locations []string,
	employmentType, locale string,
	mu *sync.Mutex,
	budget *int,
) ([]search.Result, error) {
	attempts := buildFallbackQueries(host, query, locations, employmentType)
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

// ---- pre-filter + gone cache ----

// Avoid-wasted-work drops. preFilterHits screens raw hits; goneCache
// memoizes 404s across Runs in a process; probeSPADeadPage body-scans
// SPAs whose dead pages return 200.

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

// ---- extract ----

// extractPostings turns raw search hits into JobPostings. budget targets
// SURVIVORS, not attempts — gone URLs cost a fetch slot but not a budget
// slot. Runs in batches of extractConcurrency, stops once budget is met.
func extractPostings(ctx context.Context, hits []SearchHit, atsReg ATSFetcher, gone *goneCache, budget int) (postings []JobPosting, droppedGone int) {
	if budget <= 0 || len(hits) == 0 {
		return nil, 0
	}
	out := make([]JobPosting, 0, budget)
	for i := 0; i < len(hits) && len(out) < budget; {
		end := min(i+extractConcurrency, len(hits))
		results := make([]JobPosting, end-i)
		goneFlags := make([]bool, end-i)
		var wg sync.WaitGroup
		for j := range hits[i:end] {
			j := j
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[j], goneFlags[j] = extractEach(ctx, hits[i+j], atsReg)
			}()
		}
		wg.Wait()
		for j, p := range results {
			if goneFlags[j] {
				gone.Add(p.URL)
				droppedGone++
				continue
			}
			if len(out) < budget {
				out = append(out, p)
			}
		}
		i = end
	}
	return out, droppedGone
}

// extractEach returns (posting, isGone). When isGone is true, only URL
// on the posting is meaningful — the caller records it and drops.
func extractEach(ctx context.Context, h SearchHit, atsReg ATSFetcher) (JobPosting, bool) {
	// SPA hosts (Google Careers etc.) whose dead pages return 200 leave
	// per-host fingerprints in the body. Config-driven — hosts without
	// registered markers short-circuit with zero network cost.
	if isDead, err := probeSPADeadPage(ctx, h.URL); err == nil && isDead {
		log.Printf("discover: dropped gone posting (dead-marker) url=%s", h.URL)
		return JobPosting{URL: h.URL}, true
	}
	// Catches hosts that 302 removed postings to a tenant landing page
	// (Workable → `/{tenant}/?not_found=true`). Cheap URL-shape check already
	// ran in preFilterHits; this one follows redirects and re-checks.
	if atsReg != nil && atsReg.ResolvesToLandingPage(ctx, h.URL) {
		log.Printf("discover: dropped gone posting (resolves-to-landing) url=%s", h.URL)
		return JobPosting{URL: h.URL}, true
	}
	if atsReg != nil && atsReg.HasSupportingProvider(h.URL) {
		posting, err := atsReg.Fetch(ctx, h.URL)
		if err == nil && strings.TrimSpace(posting.Title) != "" {
			return JobPosting{
				Title:          posting.Title,
				URL:            util.FirstNonEmpty(posting.ApplyURL, h.URL),
				Company:        posting.Company,
				Source:         posting.Provider,
				Snippet:        util.FirstNonEmpty(posting.DescriptionText, h.Snippet),
				Location:       posting.Location,
				EmploymentType: posting.EmploymentType,
				BoardURL:       h.BoardURL,
				Provider:       util.FirstNonEmpty(posting.Provider, h.Provider),
				PostedAt:       util.CoalesceTime(posting.PostedAt, h.PublishedAt),
			}, false
		}
		// Any failure on a supporting host is a strong "gone" signal — the
		// structured extractor is the source of truth for these providers and
		// a live posting always yields a title. Non-404 errors (missing
		// JSON-LD, malformed body) and empty-title 200s both indicate the
		// posting is removed or malformed; falling back to the search snippet
		// just manufactures a bogus recommendation from cached copy.
		log.Printf("discover: dropped gone posting url=%s err=%v", h.URL, err)
		return JobPosting{URL: h.URL}, true
	}
	// Non-ATS host or ATS fetch failed non-404 — fall through with the
	// search-engine snippet.
	return JobPosting{
		Title:    h.Title,
		URL:      h.URL,
		Source:   "search",
		Snippet:  h.Snippet,
		BoardURL: h.BoardURL,
		Provider: h.Provider,
		PostedAt: util.CoalesceTime(h.PublishedAt),
	}, false
}

// ---- rank ----

func (s *Service) rankPostings(ctx context.Context, req DiscoverRequest, postings []JobPosting, limit int) ([]Recommendation, error) {
	if len(postings) == 0 {
		return nil, nil
	}
	blob, err := json.Marshal(rankContext{
		Profile:        req.Profile,
		Postings:       capPostings(postings),
		Limit:          limit,
		EmploymentType: req.Profile.EmploymentType,
		Location:       deriveLocationContext(req.Profile.Locations),
	})
	if err != nil {
		return nil, fmt.Errorf("marshal rank context: %w", err)
	}
	set := llm.PickPromptSet(rankJobsPrompts(), req.Locale)
	prompt := llm.Prompt{System: set.System, User: fmt.Sprintf(set.User, string(blob))}
	var out rankResponse
	if err := s.llm.GenerateJSON(ctx, prompt, &out); err != nil {
		return nil, fmt.Errorf("rank-jobs llm: %w", err)
	}

	// URL whitelist: recs must reference postings we sent (block hallucinated URLs).
	allowed := make(map[string]JobPosting, len(postings))
	for _, p := range postings {
		if key := normalizeURL(p.URL); key != "" {
			allowed[key] = p
		}
	}
	cleaned := make([]Recommendation, 0, len(out.Recommendations))
	for _, r := range out.Recommendations {
		url := strings.TrimSpace(r.URL)
		title := strings.TrimSpace(r.Title)
		if url == "" || title == "" {
			continue
		}
		origin, ok := allowed[normalizeURL(url)]
		if !ok {
			continue
		}
		if r.MatchScore < minMatchScore {
			r.MatchScore = minMatchScore
		}
		if r.MatchScore > maxMatchScore {
			r.MatchScore = maxMatchScore
		}
		company := util.FirstNonEmpty(strings.TrimSpace(r.Company), origin.Company, companyFromURL(url))
		cleaned = append(cleaned, Recommendation{
			Title:      title,
			Company:    company,
			URL:        url,
			MatchScore: r.MatchScore,
			Rationale:  llm.SanitizeText(r.Rationale),
			Provider:   origin.Provider,
			BoardURL:   origin.BoardURL,
			PostedAt:   origin.PostedAt,
		})
		if len(cleaned) >= limit {
			break
		}
	}
	return cleaned, nil
}
