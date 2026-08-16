// Package discover recommends job posting URLs. The LLM derives role
// phrasings and signal keywords from the profile (with the user's saved
// companies as taste input), the pipeline then searches a fixed list of
// shared-host ATS platforms with those keywords, extracts postings, and
// re-ranks them via a second LLM call.
//
// Stateless — the browser holds all persistent data and posts the profile
// context in the request body.
package discover

import (
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/ats"
)

// DefaultLimit is the number of ranked recommendations returned when the
// caller does not specify one.
const DefaultLimit = 10

// ProfileSummary is the string-only view of the user's profile the pipeline
// sends to the LLM. Full profile objects (résumés, brag bodies, etc.) never
// leave the browser.
//
// EmploymentType and Locations act as hard filters in the prompts. The
// pipeline derives an explicit location_mode + physical_locations split from
// Locations before handing them to the LLM (see deriveLocationContext below).
// Headline is also load-bearing at the search step — it becomes the fallback
// role query when the LLM returns no role_variants.
type ProfileSummary struct {
	Headline       string   `json:"headline"`
	Summary        string   `json:"summary"`
	Skills         []string `json:"skills"`
	Locations      []string `json:"locations"`
	EmploymentType string   `json:"employment_type,omitempty"`
}

// SeedCompany is one company the user has added locally. Fed to the expand
// prompt as taste input (which industry / stage the user gravitates toward);
// no search is issued per-company. Only Name is read — the browser may send
// more fields, which the JSON decoder silently ignores.
type SeedCompany struct {
	Name string `json:"name"`
}

// ExistingApplication is used only to dedupe extracted postings against
// URLs the user already tracks. Extra fields on the request payload are
// ignored by json.Unmarshal.
type ExistingApplication struct {
	JobURL string `json:"job_url,omitempty"`
}

// DiscoverRequest is the browser payload to /api/discover/run. All fields are
// optional; missing signals just weaken the recommendations.
type DiscoverRequest struct {
	Profile      ProfileSummary        `json:"profile"`
	Companies    []SeedCompany         `json:"companies"`
	Applications []ExistingApplication `json:"applications"`
	// ExcludeURLs are posting URLs the client has already surfaced in a
	// prior Discover run. Combined with Applications for dedupe so repeat
	// runs produce fresh results instead of reordering the same set.
	ExcludeURLs  []string `json:"exclude_urls,omitempty"`
	BragTitles   []string `json:"brag_titles"`
	CareerSparks []string `json:"career_sparks"`
	Locale       string   `json:"locale"`
	Limit        int      `json:"limit"`

	// BrowserHits carries search results the browser fetched itself via BYOK
	// (Tavily / Brave). When non-empty, service.Run skips its own SearXNG
	// step and feeds these into extraction instead. Static-host builds and
	// hosted-BYOK users flow through this field.
	BrowserHits []BrowserHitGroup `json:"browser_hits,omitempty"`
}

// BrowserHitGroup is one host's worth of BYOK search results, shaped the
// same as a single searchHosts iteration so the pipeline consumes it
// interchangeably with server-side results.
type BrowserHitGroup struct {
	Host     string             `json:"host"`
	Provider string             `json:"provider"`
	BoardURL string             `json:"board_url"`
	Results  []BrowserHitResult `json:"results"`
}

// BrowserHitResult is a single search result inside a BrowserHitGroup,
// shaped to mirror the fields SearXNG returns.
type BrowserHitResult struct {
	URL         string    `json:"url"`
	Title       string    `json:"title"`
	Content     string    `json:"content"`
	Engine      string    `json:"engine"`
	PublishedAt time.Time `json:"published_at,omitempty"`
}

// SearchSignals is the expand step's output: LLM-derived role phrasings
// plus secondary keywords for query construction.
type SearchSignals struct {
	// RoleVariants: 3–5 alternate phrasings of profile.headline, same
	// specificity. Primary OR-group in the site-scoped query.
	RoleVariants []string `json:"role_variants"`
	// SignalKeywords: 3–5 industry/tech-stack/stage keywords derived from
	// seed companies + skills + sparks. Soft OR-group to nudge recall.
	SignalKeywords []string `json:"signal_keywords"`
	// BroadRole: one broader/parent term (e.g. "Software Engineer" when
	// headline is "Backend Engineer"). Used only for scarce employment
	// types (intern / new_grad) where the specific-variant OR-group
	// narrows the small posting pool to zero. Empty when the LLM has no
	// broader form to offer.
	BroadRole string `json:"broad_role"`
}

// ATSHost names one search target — a shared-host ATS platform we iterate
// over during the site-scoped search step. Host is bare (e.g.,
// "boards.greenhouse.io"); prepend "https://" when a URL is needed for
// client-facing fields. Alias to ats.SearchHost so the config in
// ats-providers.json drives this without a second definition.
type ATSHost = ats.SearchHost

// SearchHit is a raw web-search result before ATS/scrape extraction.
// BoardURL + Provider identify the ATS host the hit came from and flow
// through to Recommendation so the client can pre-fill a new company row.
// PublishedAt is the search engine's page-indexed date (weak signal;
// preferred to the ATS's own posted-at when that's absent).
type SearchHit struct {
	URL         string
	Title       string
	Snippet     string
	Engine      string
	BoardURL    string
	Provider    string
	PublishedAt time.Time
}

// JobPosting is a concrete posting extracted from an ATS or a listing page.
// Fields with json tags are visible to the rank LLM; the rest flow through
// to the client's Recommendation but stay out of the prompt.
type JobPosting struct {
	Title    string `json:"title"`
	URL      string `json:"url"`
	Company  string `json:"company"`
	Source   string `json:"source,omitempty"`  // ats provider name, or "search"
	Snippet  string `json:"snippet,omitempty"` // DescriptionText excerpt, or search-engine snippet
	Location string `json:"location,omitempty"`
	// EmploymentType is the raw ATS-declared value (Ashby's "FULL_TIME",
	// Lever's "Full-time", "Intern"). Passes to the ranker as-is; the LLM
	// normalizes across providers. Empty for search-only postings.
	EmploymentType string `json:"employment_type,omitempty"`

	BoardURL string     `json:"-"`
	Provider string     `json:"-"`
	PostedAt *time.Time `json:"-"` // nil = unknown; ranker sees a derived posted_days_ago
}

// Recommendation is a ranked posting in the final response. Provider,
// BoardURL, and PostedAt come from the matched input JobPosting so the
// client can pre-populate a new company row on Save-as-application and
// render freshness without re-deriving.
type Recommendation struct {
	Title      string     `json:"title"`
	Company    string     `json:"company"`
	URL        string     `json:"url"`
	MatchScore int        `json:"match_score"`
	Rationale  string     `json:"rationale"`
	Provider   string     `json:"provider,omitempty"`
	BoardURL   string     `json:"board_url,omitempty"`
	// Pointer so omitempty actually drops it — a zero time.Time would
	// otherwise render as "0001-01-01T00:00:00Z" and the UI would show
	// "posted 2025 years ago" for postings the ATS didn't stamp.
	PostedAt *time.Time `json:"posted_at,omitempty"`
}

// DiscoverResponse is the /api/discover/run body.
type DiscoverResponse struct {
	Recommendations []Recommendation `json:"recommendations"`
	Diagnostics     []string         `json:"diagnostics,omitempty"`
}

// LocationMode summarizes what the pipeline should do with the user's target
// locations. Explicit modes are easier for the LLM to obey than a raw list.
type LocationMode string

const (
	LocationModeAny            LocationMode = "any"              // no target set
	LocationModeRemoteOnly     LocationMode = "remote_only"      // all entries are Remote-flavored
	LocationModeCitiesOrRemote LocationMode = "cities_or_remote" // cities + at least one Remote
	LocationModeCitiesOnly     LocationMode = "cities_only"      // cities only, no Remote
)

// LocationContext is the derived shape sent to LLM prompts.
type LocationContext struct {
	Mode              LocationMode `json:"location_mode"`
	PhysicalLocations []string     `json:"physical_locations,omitempty"`
	RemoteOK          bool         `json:"remote_ok"`
}

// deriveLocationContext splits user locations into (mode, physical, remote?).
// Case-insensitive: an entry is Remote-flavored when its trimmed value
// starts with "remote" (matches "Remote", "Remote (US)", "Remote-first";
// not "New York (remote-friendly)").
func deriveLocationContext(locations []string) LocationContext {
	physical := make([]string, 0, len(locations))
	hasRemote := false
	for _, raw := range locations {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(s), "remote") {
			hasRemote = true
			continue
		}
		physical = append(physical, s)
	}
	switch {
	case len(physical) == 0 && !hasRemote:
		return LocationContext{Mode: LocationModeAny}
	case len(physical) == 0 && hasRemote:
		return LocationContext{Mode: LocationModeRemoteOnly, RemoteOK: true}
	case len(physical) > 0 && hasRemote:
		return LocationContext{Mode: LocationModeCitiesOrRemote, PhysicalLocations: physical, RemoteOK: true}
	default:
		return LocationContext{Mode: LocationModeCitiesOnly, PhysicalLocations: physical}
	}
}
