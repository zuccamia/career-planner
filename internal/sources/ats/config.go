package ats

// Shared ATS provider config, loaded from web/static/data/ats-providers.json
// at process boot (same runtime-read pattern as LLM prompts).

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
)

// ProviderConfig mirrors one entry in ats-providers.json.
//   - SearchHosts drives the site-scoped search step.
//   - HostPattern + SlugInPath: URL → provider inference and path normalization.
//   - DeadMarkers: substrings whose presence in the URL's GET body means
//     the posting is gone (SPA hosts whose dead pages return HTTP 200).
type ProviderConfig struct {
	Provider    string   `json:"provider"`
	SearchHosts []string `json:"search_hosts"`
	HostPattern string   `json:"host_pattern"`
	SlugInPath  bool     `json:"slug_in_path"`
	DeadMarkers []string `json:"dead_markers,omitempty"`
}

// SearchHost is one (host, provider) pair suitable for iterating during the
// site-scoped search step.
type SearchHost struct {
	Host     string
	Provider string
}

// compiledHostPattern pairs a compiled HostPattern regex with the provider it
// belongs to plus any dead-body markers for that host. Built once per
// LoadProviders call.
type compiledHostPattern struct {
	provider    string
	rx          *regexp.Regexp
	deadMarkers []string
	slugInPath  bool
}

// providersCache is the derived view of the loaded ProviderConfig list.
// Held behind an atomic pointer so concurrent readers see a consistent
// snapshot even if a test calls LoadProviders() mid-flight.
type providersCache struct {
	configs      []ProviderConfig
	searchHosts  []SearchHost
	hostPatterns []compiledHostPattern
}

var providers atomic.Pointer[providersCache]

// LoadProviders reads ats-providers.json from dir. Idempotent; overwrites
// any prior load atomically.
func LoadProviders(dir string) error {
	path := filepath.Join(dir, "ats-providers.json")
	blob, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	var parsed []ProviderConfig
	if err := json.Unmarshal(blob, &parsed); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	providers.Store(&providersCache{
		configs:      parsed,
		searchHosts:  buildSearchHosts(parsed),
		hostPatterns: buildHostPatterns(parsed),
	})
	return nil
}

func buildSearchHosts(cfgs []ProviderConfig) []SearchHost {
	out := make([]SearchHost, 0)
	for _, p := range cfgs {
		for _, h := range p.SearchHosts {
			out = append(out, SearchHost{Host: h, Provider: p.Provider})
		}
	}
	return out
}

func buildHostPatterns(cfgs []ProviderConfig) []compiledHostPattern {
	out := make([]compiledHostPattern, 0, len(cfgs))
	for _, p := range cfgs {
		if p.HostPattern == "" {
			continue
		}
		rx, err := regexp.Compile("(?i)" + p.HostPattern)
		if err != nil {
			log.Printf("ats: skipping provider %q — invalid host_pattern %q: %v", p.Provider, p.HostPattern, err)
			continue
		}
		out = append(out, compiledHostPattern{provider: p.Provider, rx: rx, deadMarkers: p.DeadMarkers, slugInPath: p.SlugInPath})
	}
	return out
}

// Providers returns the loaded ProviderConfig list, or nil before Load.
// Callers should not mutate the returned slice — it's shared across readers.
func Providers() []ProviderConfig {
	c := providers.Load()
	if c == nil {
		return nil
	}
	return c.configs
}

// SearchHosts returns the flat (host, provider) pairs across every loaded
// provider — the list the discover pipeline iterates over per Run.
func SearchHosts() []SearchHost {
	c := providers.Load()
	if c == nil {
		return nil
	}
	return c.searchHosts
}

// hostPatterns returns the pre-compiled HostPattern regexes for LookupATSURL.
// Unexported: only ats-internal callers need the compiled form.
func hostPatterns() []compiledHostPattern {
	c := providers.Load()
	if c == nil {
		return nil
	}
	return c.hostPatterns
}

// DeadMarkersForHost returns the substrings whose presence in the URL's
// body signals a dead posting. Returns nil when the host has no
// registered markers (structured providers, generic hosts).
func DeadMarkersForHost(host string) []string {
	for _, hp := range hostPatterns() {
		if len(hp.deadMarkers) > 0 && hp.rx.MatchString(host) {
			return hp.deadMarkers
		}
	}
	return nil
}

// LookupHost returns (providerName, slugInPath, matched) for the first
// host_pattern that matches. Piggy-backs on the compiled cache built by
// LoadProviders so callers don't recompile regexes.
func LookupHost(host string) (provider string, slugInPath, matched bool) {
	for _, hp := range hostPatterns() {
		if hp.rx.MatchString(host) {
			return hp.provider, hp.slugInPath, true
		}
	}
	return "", false, false
}

// PrettifySlug turns "high-agency-labs" into "High Agency Labs"; leaves
// already-capitalized slugs (Visa, WesternDigital) alone so acronyms stay
// upper. Shared between extractors that derive Company from a URL slug and
// discover's URL-tenant fallback.
func PrettifySlug(s string) string {
	s = strings.TrimSpace(strings.NewReplacer("-", " ", "_", " ").Replace(s))
	if s == "" {
		return ""
	}
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 && strings.ToLower(w) == w {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}
