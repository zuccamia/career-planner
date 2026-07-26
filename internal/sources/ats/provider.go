// Package ats fetches job postings from applicant tracking systems and other
// job-board sources. Each Provider knows how to recognize and normalize one
// source; a Registry routes a URL to the first supporting provider, falling
// back to the generic HTML/JSON-LD scraper.
package ats

import (
	"context"
	"fmt"
)

// Posting is the normalized result of fetching a job posting.
//
// Only DescriptionText is guaranteed to be populated. ATS-specific providers
// fill in the structured fields when the source exposes them; the generic
// fallback leaves them empty and the LLM extracts everything from the text.
type Posting struct {
	Provider        string
	Title           string
	Company         string
	Location        string
	Department      string
	Team            string
	Compensation    string
	ApplyURL        string
	DescriptionText string
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

// Fetch picks the first supporting provider and delegates. If no provider
// matches, the fallback is used. A nil registry or nil fallback with no match
// returns an error.
func (r *Registry) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	if r == nil {
		return Posting{}, fmt.Errorf("ats registry is not configured")
	}
	canonical := Canonicalize(rawURL)
	parsed, err := ValidateFetchURL(canonical)
	if err != nil {
		return Posting{}, err
	}
	canonical = parsed.String()
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
