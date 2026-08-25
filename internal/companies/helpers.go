package companies

import (
	"net/url"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// ---- candidate lookup ----

// sanitizeCandidate trims and URL-normalizes guessed company fields while preserving a fallback name.
func sanitizeCandidate(candidate Candidate, fallbackName string) Candidate {
	candidate.OfficialName = strings.TrimSpace(candidate.OfficialName)
	candidate.Website = sanitizeHTTPURL(candidate.Website)
	candidate.BlogURL = sanitizeHTTPURL(candidate.BlogURL)
	candidate.ATSURL = sanitizeHTTPURL(candidate.ATSURL)
	candidate.ATSProvider = strings.TrimSpace(candidate.ATSProvider)
	candidate.Reasoning = llm.SanitizeText(candidate.Reasoning)
	if candidate.OfficialName == "" {
		candidate.OfficialName = fallbackName
	}
	return candidate
}

// sanitizeHTTPURL returns the input only if it parses as an http(s) URL.
func sanitizeHTTPURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	return parsed.String()
}

// ---- dossier build ----

// finalizeDossier sanitizes a decoded LLM result and maps it into the domain
// Dossier shape.
func finalizeDossier(generated dossierLLMResult) Dossier {
	result := sanitizeDossierResult(generated)
	return Dossier{
		Status:                "completed",
		CareersURL:            result.CareersURL,
		CompanySummary:        result.CompanySummary,
		WhatTheCompanyDoes:    result.WhatCompanyDoes,
		TargetCustomers:       result.TargetCustomers,
		ProductAreas:          result.ProductAreas,
		BusinessModelClues:    result.BusinessModelClues,
		RecentProductLaunches: result.RecentProductLaunches,
		CompanyCultureNotes:   result.CompanyCultureNotes,
		HasInternships:        result.HasInternships,
		InternshipSeasons:     result.InternshipSeasons,
		InternshipSummary:     result.InternshipSummary,
		MajorTechStacks:       result.MajorTechStacks,
		Reasoning:             llm.SanitizeText(result.Reasoning),
	}
}

// sanitizeDossierResult normalizes the LLM dossier payload.
func sanitizeDossierResult(result dossierLLMResult) dossierLLMResult {
	result.CareersURL = sanitizeURL(result.CareersURL)
	result.CompanySummary = sanitizeParagraph(result.CompanySummary)
	result.WhatCompanyDoes = sanitizeParagraph(result.WhatCompanyDoes)
	result.TargetCustomers = sanitizeList(result.TargetCustomers)
	result.ProductAreas = sanitizeList(result.ProductAreas)
	result.BusinessModelClues = sanitizeList(result.BusinessModelClues)
	result.RecentProductLaunches = sanitizeProductLaunches(result.RecentProductLaunches)
	result.CompanyCultureNotes = sanitizeList(result.CompanyCultureNotes)
	result.InternshipSeasons = sanitizeList(result.InternshipSeasons)
	result.InternshipSummary = sanitizeParagraph(result.InternshipSummary)
	result.MajorTechStacks = sanitizeTechStacks(result.MajorTechStacks)
	result.Reasoning = sanitizeParagraph(result.Reasoning)
	return result
}

// sanitizeProductLaunches deduplicates launches and keeps them ordered by newest date prefix first.
func sanitizeProductLaunches(values []string) []string {
	cleaned := sanitizeList(values)
	sort.SliceStable(cleaned, func(i, j int) bool {
		leftDate, _, _ := strings.Cut(cleaned[i], " | ")
		rightDate, _, _ := strings.Cut(cleaned[j], " | ")
		return leftDate > rightDate
	})
	return cleaned
}

// sanitizeParagraph collapses whitespace in free-form text fields.
func sanitizeParagraph(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

// sanitizeTechStacks normalizes each tech stack bucket independently.
func sanitizeTechStacks(stacks MajorTechStacks) MajorTechStacks {
	stacks.Languages = sanitizeList(stacks.Languages)
	stacks.Frontend = sanitizeList(stacks.Frontend)
	stacks.Backend = sanitizeList(stacks.Backend)
	stacks.Infrastructure = sanitizeList(stacks.Infrastructure)
	stacks.Data = sanitizeList(stacks.Data)
	stacks.Tooling = sanitizeList(stacks.Tooling)
	return stacks
}

// formatScrapedBlock returns "" when raw is blank, else a labeled block ready
// for interpolation. `label` is the untrusted-content marker (e.g.
// "WEBSITE_CONTENT"), used as BEGIN_UNTRUSTED_<label> / END_UNTRUSTED_<label>.
// Content is truncated to ScrapedContentMaxBytes.
func formatScrapedBlock(label, raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if len(trimmed) > ScrapedContentMaxBytes {
		trimmed = trimmed[:ScrapedContentMaxBytes]
	}
	return "\nBEGIN_UNTRUSTED_" + label + "\n" + trimmed + "\nEND_UNTRUSTED_" + label + "\n"
}

// ---- shared ----

// sanitizeList trims, deduplicates, and drops empty strings while preserving first-seen order.
func sanitizeList(values []string) []string {
	cleaned := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		normalized := sanitizeParagraph(value)
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		cleaned = append(cleaned, normalized)
	}
	return cleaned
}

// sanitizeURL returns the input only if it parses with a scheme and host.
func sanitizeURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.String()
}
