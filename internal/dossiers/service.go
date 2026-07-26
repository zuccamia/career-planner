package dossiers

// Generates dossiers from company data. No persistence — the browser stores
// the result locally after receiving it from the RPC layer.

import (
	"context"
	"fmt"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/sources/llm"
)

// BuildText generates a dossier for a company without persisting it. The RPC
// handler forwards the returned Dossier to the browser, which owns storage.
func (s *Service) BuildText(ctx context.Context, company companies.Company) Dossier {
	result := fallbackResult(company)
	if s.client != nil {
		prompt := llm.Prompt{System: dossierSystemPrompt, User: fmt.Sprintf(dossierUserPrompt,
			company.OfficialName,
			company.Website,
			company.ATSURL,
			company.ATSProvider,
		)}

		var generated llmResult
		if err := s.client.GenerateJSON(ctx, prompt, &generated); err == nil {
			result = mergeResult(result, sanitizeResult(generated, company))
		}
	}

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
		Reasoning:             result.Reasoning,
	}
}
