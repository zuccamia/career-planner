package dossiers

// Generates dossiers from company data. No persistence — the browser stores
// the result locally after receiving it from the RPC layer.

import (
	"context"
	"fmt"

	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// BuildText generates a dossier for a company via the LLM without persisting
// it. The RPC handler forwards the returned Dossier to the browser, which
// owns storage. Errors surface when the LLM client is unconfigured or fails.
func (s *Service) BuildText(ctx context.Context, company companies.Company) (Dossier, error) {
	if s.client == nil {
		return Dossier{}, fmt.Errorf("llm client is not configured")
	}
	prompt := llm.Prompt{System: dossierSystemPrompt, User: fmt.Sprintf(dossierUserPrompt,
		company.OfficialName,
		company.Website,
		company.ATSURL,
		company.ATSProvider,
	)}

	var generated llmResult
	if err := s.client.GenerateJSON(ctx, prompt, &generated); err != nil {
		return Dossier{}, fmt.Errorf("generate dossier: %w", err)
	}
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
		Reasoning:             result.Reasoning,
	}, nil
}
