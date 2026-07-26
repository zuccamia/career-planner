package dossiers

// Generates dossiers from company data and persists the results.

import (
	"context"
	"fmt"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/sources/llm"
)

// Build generates a dossier for a company, merging fallback values with any LLM result.
func (s *Service) Build(ctx context.Context, input BuildInput) (Dossier, error) {
	if input.Company.ID <= 0 {
		return Dossier{}, companies.ErrCompanyNotFound
	}

	result := fallbackResult(input.Company)
	if s.client != nil {
		prompt := llm.Prompt{System: dossierSystemPrompt, User: fmt.Sprintf(dossierUserPrompt,
			input.Company.OfficialName,
			input.Company.Website,
			input.Company.ATSURL,
			input.Company.ATSProvider,
		)}

		var generated llmResult
		if err := s.client.GenerateJSON(ctx, prompt, &generated); err == nil {
			result = mergeResult(result, sanitizeResult(generated, input.Company))
		}
	}

	return s.repo.Create(ctx, Dossier{
		CompanyID:             input.Company.ID,
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
	})
}

// GetLatestByCompanyID returns the newest dossier stored for a company.
func (s *Service) GetLatestByCompanyID(ctx context.Context, companyID int64) (Dossier, error) {
	if companyID <= 0 {
		return Dossier{}, companies.ErrCompanyNotFound
	}
	return s.repo.GetLatestByCompanyID(ctx, companyID)
}
