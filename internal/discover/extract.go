package discover

import (
	"context"
	"log"
	"net/url"
	"strings"
	"sync"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/util"
)

// ATSFetcher is the subset of ats.Registry the extractor needs. A local
// interface lets tests substitute a stub without importing the registry.
type ATSFetcher interface {
	HasSupportingProvider(rawURL string) bool
	IsLandingPage(rawURL string) bool
	ResolvesToLandingPage(ctx context.Context, rawURL string) bool
	Fetch(ctx context.Context, rawURL string) (ats.Posting, error)
}

// extractConcurrency matches the JS mirror; stays under provider rate limits.
const extractConcurrency = 5

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

