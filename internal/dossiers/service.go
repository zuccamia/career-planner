package dossiers

// Generates dossiers from company data. No persistence — the browser stores
// the result locally after receiving it from the RPC layer.

import (
	"context"
	"fmt"

	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// ParseAndFinalize decodes a raw LLM response into the private llmResult and
// runs FinalizeDossier. Exposed for the BYOK parse endpoint, which cannot
// name llmResult directly.
func (s *Service) ParseAndFinalize(raw string) (Dossier, error) {
	var generated llmResult
	if err := llm.DecodeJSONResponse(raw, &generated); err != nil {
		return Dossier{}, err
	}
	return s.FinalizeDossier(generated), nil
}

// BuildText generates a dossier for a company via the LLM without persisting
// it. Composed from BuildDossierPrompt + FinalizeDossier so the BYOK path can
// call each half independently. `enrichment` carries optional pre-scraped
// markdown for the website/blog/careers URLs — empty fields are omitted from
// the prompt (today's default behavior when no scraper is configured).
func (s *Service) BuildText(ctx context.Context, company companies.Company, outputLanguage string, enrichment WebsiteEnrichment) (Dossier, error) {
	if s.client == nil {
		return Dossier{}, fmt.Errorf("llm client is not configured")
	}
	prompt := s.BuildDossierPrompt(company, outputLanguage, enrichment)
	var generated llmResult
	if err := s.client.GenerateJSON(ctx, prompt, &generated); err != nil {
		return Dossier{}, fmt.Errorf("generate dossier: %w", err)
	}
	return s.FinalizeDossier(generated), nil
}

// BuildDossierPrompt assembles the LLM prompt for a company dossier. Pure —
// no I/O, no LLM call. outputLanguage selects the locale-specific prompt
// template; missing locales fall back to English. `enrichment` interpolates
// up to three labeled scraped-content blocks (website / blog / careers page),
// each capped at ScrapedContentMaxBytes and omitted when empty.
func (s *Service) BuildDossierPrompt(company companies.Company, outputLanguage string, enrichment WebsiteEnrichment) llm.Prompt {
	set := llm.PickPromptSet(dossierPrompts, outputLanguage)
	return llm.Prompt{
		System: set.System,
		User: fmt.Sprintf(
			set.User,
			company.OfficialName,
			company.Website,
			company.ATSURL,
			company.ATSProvider,
			formatScrapedBlock("WEBSITE_CONTENT", enrichment.Website),
			formatScrapedBlock("BLOG_CONTENT", enrichment.Blog),
			formatScrapedBlock("CAREERS_CONTENT", enrichment.Careers),
		),
	}
}

// FinalizeDossier sanitizes a decoded LLM result and maps it into the domain
// Dossier shape. Pure — no I/O.
func (s *Service) FinalizeDossier(generated llmResult) Dossier {
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
