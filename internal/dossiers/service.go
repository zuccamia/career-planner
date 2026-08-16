package dossiers

// Generates dossiers from company data. No persistence — the browser stores
// the result locally after receiving it from the RPC layer.

import (
	"context"
	"fmt"

	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// Build generates a dossier for a company via the LLM without persisting
// it. `pages` carries optional pre-scraped markdown for the website/blog/
// careers URLs — empty fields are omitted from the prompt.
func (s *Service) Build(ctx context.Context, company companies.Company, outputLanguage string, pages Pages) (Dossier, error) {
	if s.client == nil {
		return Dossier{}, fmt.Errorf("llm client is not configured")
	}
	set := llm.PickPromptSet(dossierPrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User: fmt.Sprintf(
			set.User,
			company.OfficialName,
			company.Website,
			company.ATSURL,
			company.ATSProvider,
			formatScrapedBlock("WEBSITE_CONTENT", pages.Website),
			formatScrapedBlock("BLOG_CONTENT", pages.Blog),
			formatScrapedBlock("CAREERS_CONTENT", pages.Careers),
		),
	}
	var generated llmResult
	if err := s.client.GenerateJSON(ctx, prompt, &generated); err != nil {
		return Dossier{}, fmt.Errorf("generate dossier: %w", err)
	}
	return finalizeDossier(generated), nil
}

// finalizeDossier sanitizes a decoded LLM result and maps it into the domain
// Dossier shape.
func finalizeDossier(generated llmResult) Dossier {
	result := sanitizeResult(generated)
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
