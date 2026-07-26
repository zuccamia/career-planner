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

