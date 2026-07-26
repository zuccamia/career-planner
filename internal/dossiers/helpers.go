package dossiers

// Sanitizes and normalizes generated dossier content.

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/shared"
)

// sanitizeResult normalizes the full LLM dossier payload and fills derived fallbacks.
func sanitizeResult(result llmResult, company companies.Company) llmResult {
	result.CareersURL = shared.SanitizeURL(result.CareersURL)
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
	if result.CareersURL == "" {
		result.CareersURL = deriveCareersURL(company)
	}
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

// marshalJSON safely encodes slices and structs for JSON database columns.
func marshalJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}
