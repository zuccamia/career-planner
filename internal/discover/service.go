package discover

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
	"github.com/zuccamia/career-planner/internal/sources/search"
)

// Service orchestrates the discovery pipeline: LLM signal extraction →
// site-scoped search across a fixed ATS host list → extraction → URL
// dedupe → LLM rank.
type Service struct {
	llm    llm.Client
	search search.Client
	scrape scrape.Client
	ats    ATSFetcher
	gone   *goneCache // process-lifetime; see gonecache.go
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

// extractBudget targets survivor count (not attempts) — extractPostings
// keeps fetching until it has this many non-gone postings or runs out of
// hits. Concurrency in extract.go keeps wall time bounded.
const extractBudget = 40

// Length caps applied to inbound DiscoverRequest fields. Bound prompt cost and
// shrink the surface for prompt-injection payloads in long free-text fields.
const (
	capHeadline     = 200
	capSummary      = 2000
	capSkillName    = 100
	capSkills       = 50
	capLocationName = 100
	capLocations    = 20
	capCompanyName  = 200
	capCompanies    = 100
	capJobURL       = 2000
	capApplications = 200
	capExcludeURLs  = 200 // cap on client's shown-recs history sent per run
	capBragTitle    = 200
	capBragTitles   = 20
	capCareerSpark  = 300
	capCareerSparks = 20
)

// Staleness windows applied by filterStalePostings. Scarce roles get a
// wider window since fresh postings are rare and cyclical.
const (
	staleDefaultDays = 30
	staleScarceDays  = 90
)

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
	// expandSearchSignals falls back to the raw headline when the LLM whiffs.
	signals, err := s.expandSearchSignals(ctx, req)
	if err != nil {
		return DiscoverResponse{}, fmt.Errorf("expand signals: %w", err)
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
		hits, hitErrs = s.searchHosts(ctx, hosts, signals, req.Profile.Locations, req.Profile.EmploymentType, req.Locale, &budget)
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

// logRun emits one structured diagnostic line per Run.
//   - rankAttempts: 0 = early-exit, 1 = ranker was called.
//   - pre_*: dropped by pre-filter (tracked / landing / cached-gone / past-cycle).
//   - gone_new: 404'd for the first time this Run; also written to the cache.
//   - ranked − recs: how many the HEAD dead-link filter killed.
func (s *Service) logRun(rankAttempts, hosts, hits int, pre preFilterCounts, goneNew, postings, ranked, recs int) {
	log.Printf("discover: rankAttempts=%d hosts=%d hits=%d pre_dedupe=%d pre_shape=%d gone_cached=%d past_cycle=%d gone_new=%d postings=%d ranked=%d recs=%d",
		rankAttempts, hosts, hits, pre.dedupe, pre.shape, pre.goneCached, pre.pastCycle, goneNew, postings, ranked, recs)
}

// --- Run-only helpers below ---

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
