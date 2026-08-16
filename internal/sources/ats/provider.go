// Package ats fetches job postings from applicant tracking systems and other
// job-board sources. Each Provider knows how to recognize and normalize one
// source; a Registry routes a URL to the first supporting provider, falling
// back to the generic HTML/JSON-LD scraper.
package ats

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Posting is the normalized result of fetching a job posting.
//
// Only DescriptionText is guaranteed to be populated. ATS-specific providers
// fill in the structured fields when the source exposes them; the generic
// fallback leaves them empty and the LLM extracts everything from the text.
type Posting struct {
	Provider        string `json:"provider"`
	Title           string `json:"title"`
	Company         string `json:"company"`
	Location        string `json:"location"`
	Department      string `json:"department,omitempty"`
	Team            string `json:"team,omitempty"`
	Compensation    string `json:"compensation,omitempty"`
	ApplyURL        string `json:"apply_url"`
	DescriptionText string `json:"description_text"`
	// EmploymentType is the raw source value (e.g. Ashby's "FULL_TIME",
	// Lever's "Full-time", "Intern"). Consumers normalize into their own
	// enum. Empty when the source doesn't expose it.
	EmploymentType string `json:"employment_type,omitempty"`
	// PostedAt is the posting's publish/first-created time when the source
	// exposes it. Zero-value = unknown; callers must not treat zero as a
	// valid ancient date.
	PostedAt time.Time `json:"posted_at"`
}

// Provider fetches a job posting for URLs it recognizes.
type Provider interface {
	// Name identifies the provider (e.g. "greenhouse", "lever", "generic").
	Name() string
	// Supports reports whether this provider can handle the given URL.
	Supports(rawURL string) bool
	// Fetch retrieves and normalizes the posting.
	Fetch(ctx context.Context, rawURL string) (Posting, error)
}

// Registry routes a URL to the first supporting Provider. If none match, it
// falls through to the fallback provider (typically the generic scraper).
type Registry struct {
	providers []Provider
	fallback  Provider
}

// NewRegistry builds a registry with an ordered list of ATS-specific providers
// and a fallback used when none of them Supports the URL.
func NewRegistry(fallback Provider, providers ...Provider) *Registry {
	return &Registry{providers: providers, fallback: fallback}
}

// canonicalURL canonicalizes rawURL (strip tracking params) and validates it
// as a safely-fetchable http(s) URL. Returns the normalized form callers can
// hand to providers.
func canonicalURL(rawURL string) (string, error) {
	parsed, err := ValidateFetchURL(Canonicalize(rawURL))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

// HasSupportingProvider reports whether any of the ordered ATS-specific
// providers recognizes the URL — i.e. whether Fetch would use a structured
// provider (Greenhouse/Lever/Ashby) rather than fall through to the fallback.
// Callers use this to branch on "known ATS vs generic web page" before
// deciding whether to reach for a scraper instead.
func (r *Registry) HasSupportingProvider(rawURL string) bool {
	if r == nil {
		return false
	}
	canonical, err := canonicalURL(rawURL)
	if err != nil {
		return false
	}
	for _, p := range r.providers {
		if p != nil && p.Supports(canonical) {
			return true
		}
	}
	return false
}

// IsLandingPage reports true when the URL's host matches a structured
// provider's host_pattern but no provider's Supports() matches — e.g.
// boards.greenhouse.io/acme (tenant landing) vs .../acme/jobs/123.
// Pre-filters use this to skip URLs that would only fetch a 404.
func (r *Registry) IsLandingPage(rawURL string) bool {
	if r == nil {
		return false
	}
	canonical, err := canonicalURL(rawURL)
	if err != nil {
		return false
	}
	parsed, err := url.Parse(canonical)
	if err != nil || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	structured := make(map[string]struct{}, len(r.providers))
	for _, p := range r.providers {
		if p != nil {
			structured[p.Name()] = struct{}{}
		}
	}
	hostKnown := false
	for _, hp := range hostPatterns() {
		if _, ok := structured[hp.provider]; !ok {
			continue
		}
		if hp.rx.MatchString(host) {
			hostKnown = true
			break
		}
	}
	if !hostKnown {
		return false
	}
	for _, p := range r.providers {
		if p != nil && p.Supports(canonical) {
			return false
		}
	}
	return true
}

// Fetch picks the first supporting provider and delegates. If no provider
// matches, the fallback is used. A nil registry or nil fallback with no match
// returns an error.
func (r *Registry) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	if r == nil {
		return Posting{}, fmt.Errorf("ats registry is not configured")
	}
	canonical, err := canonicalURL(rawURL)
	if err != nil {
		return Posting{}, err
	}
	for _, p := range r.providers {
		if p != nil && p.Supports(canonical) {
			return p.Fetch(ctx, canonical)
		}
	}
	if r.fallback == nil {
		return Posting{}, fmt.Errorf("no ats provider matched and no fallback configured")
	}
	return r.fallback.Fetch(ctx, canonical)
}
