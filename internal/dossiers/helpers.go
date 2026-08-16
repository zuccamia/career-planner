package dossiers

// Sanitizes and normalizes generated dossier content.

import (
	"net/url"
	"sort"
	"strings"
)

// sanitizeResult normalizes the LLM dossier payload.
func sanitizeResult(result llmResult) llmResult {
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
		left := cleaned[i]
		right := cleaned[j]
		leftDate, _, _ := strings.Cut(left, " | ")
		rightDate, _, _ := strings.Cut(right, " | ")
		return leftDate > rightDate
	})
	return cleaned
}

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

// ScrapedContentMaxBytes caps each scraped block folded into the dossier
// prompt. With up to three blocks (website + blog + careers) this bounds the
// total scraped context to ~36KB — comfortable inside small LLM windows
// alongside the system + user prompt without truncating the response budget.
const ScrapedContentMaxBytes = 12000

// Pages carries optional pre-scraped markdown for each of the
// three URLs the dossier prompt can consume. Empty fields are omitted from
// the prompt entirely (no empty header). Callers scrape URLs they care about
// and pass through only what succeeded — this struct is a pure carrier, not
// a scraper.
type Pages struct {
	Website string
	Blog    string
	Careers string
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

