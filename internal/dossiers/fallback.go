package dossiers

// Builds fallback dossier data and merges it with generated results.

import (
	"net/url"
	"regexp"

	"github.com/ngochoang/career-planner/internal/companies"
)

var productLaunchPattern = regexp.MustCompile(`^(\d{4}(?:-\d{2}(?:-\d{2})?)?)\s\|\s.+`)

// fallbackResult creates a minimal dossier payload from known company data when LLM output is absent.
func fallbackResult(company companies.Company) llmResult {
	return llmResult{
		CareersURL:         deriveCareersURL(company),
		CompanySummary:     company.OfficialName,
		WhatCompanyDoes:    company.OfficialName,
		HasInternships:     false,
		MajorTechStacks:    MajorTechStacks{},
		InternshipSeasons:  []string{},
		TargetCustomers:    []string{},
		ProductAreas:       []string{},
		BusinessModelClues: []string{},
	}
}

// mergeResult overlays non-empty generated fields onto the fallback dossier payload.
func mergeResult(base, override llmResult) llmResult {
	if override.CareersURL != "" {
		base.CareersURL = override.CareersURL
	}
	if override.CompanySummary != "" {
		base.CompanySummary = override.CompanySummary
	}
	if override.WhatCompanyDoes != "" {
		base.WhatCompanyDoes = override.WhatCompanyDoes
	}
	if len(override.TargetCustomers) > 0 {
		base.TargetCustomers = override.TargetCustomers
	}
	if len(override.ProductAreas) > 0 {
		base.ProductAreas = override.ProductAreas
	}
	if len(override.BusinessModelClues) > 0 {
		base.BusinessModelClues = override.BusinessModelClues
	}
	if len(override.RecentProductLaunches) > 0 {
		base.RecentProductLaunches = override.RecentProductLaunches
	}
	if len(override.CompanyCultureNotes) > 0 {
		base.CompanyCultureNotes = override.CompanyCultureNotes
	}
	if override.HasInternships {
		base.HasInternships = true
	}
	if len(override.InternshipSeasons) > 0 {
		base.InternshipSeasons = override.InternshipSeasons
	}
	if override.InternshipSummary != "" {
		base.InternshipSummary = override.InternshipSummary
	}
	base.MajorTechStacks = mergeTechStacks(base.MajorTechStacks, override.MajorTechStacks)
	return base
}

// mergeTechStacks overlays populated tech stack categories onto existing defaults.
func mergeTechStacks(base, override MajorTechStacks) MajorTechStacks {
	if len(override.Languages) > 0 {
		base.Languages = override.Languages
	}
	if len(override.Frontend) > 0 {
		base.Frontend = override.Frontend
	}
	if len(override.Backend) > 0 {
		base.Backend = override.Backend
	}
	if len(override.Infrastructure) > 0 {
		base.Infrastructure = override.Infrastructure
	}
	if len(override.Data) > 0 {
		base.Data = override.Data
	}
	if len(override.Tooling) > 0 {
		base.Tooling = override.Tooling
	}
	return base
}

// deriveCareersURL infers a careers page from the ATS URL or the company website.
func deriveCareersURL(company companies.Company) string {
	if company.ATSURL != "" {
		return company.ATSURL
	}
	if company.Website == "" {
		return ""
	}
	parsed, err := url.Parse(company.Website)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	parsed.Path = "/careers"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}
