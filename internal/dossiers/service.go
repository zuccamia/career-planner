package dossiers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/llm"
)

var ErrDossierNotFound = errors.New("dossier not found")

type MajorTechStacks struct {
	Languages      []string `json:"languages"`
	Frontend       []string `json:"frontend"`
	Backend        []string `json:"backend"`
	Infrastructure []string `json:"infrastructure"`
	Data           []string `json:"data"`
	Tooling        []string `json:"tooling"`
}

type Dossier struct {
	ID                 int64
	CompanyID          int64
	Status             string
	CareersURL         string
	CompanySummary     string
	WhatTheCompanyDoes string
	TargetCustomers    []string
	ProductAreas       []string
	BusinessModelClues []string
	MajorTechStacks    MajorTechStacks
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type BuildInput struct {
	Company companies.Company
}

type llmResult struct {
	CareersURL         string          `json:"careers_url"`
	CompanySummary     string          `json:"company_summary"`
	WhatCompanyDoes    string          `json:"what_the_company_does"`
	TargetCustomers    []string        `json:"target_customers"`
	ProductAreas       []string        `json:"product_areas"`
	BusinessModelClues []string        `json:"business_model_clues"`
	MajorTechStacks    MajorTechStacks `json:"major_tech_stacks"`
}

type Repository interface {
	Create(ctx context.Context, dossier Dossier) (Dossier, error)
	GetLatestByCompanyID(ctx context.Context, companyID int64) (Dossier, error)
}

type Service struct {
	client llm.Client
	repo   Repository
}

func NewService(client llm.Client, repo Repository) *Service {
	return &Service{client: client, repo: repo}
}

func (s *Service) Build(ctx context.Context, input BuildInput) (Dossier, error) {
	if s == nil || s.repo == nil {
		return Dossier{}, errors.New("dossiers repository is not configured")
	}
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
		CompanyID:          input.Company.ID,
		Status:             "completed",
		CareersURL:         result.CareersURL,
		CompanySummary:     result.CompanySummary,
		WhatTheCompanyDoes: result.WhatCompanyDoes,
		TargetCustomers:    result.TargetCustomers,
		ProductAreas:       result.ProductAreas,
		BusinessModelClues: result.BusinessModelClues,
		MajorTechStacks:    result.MajorTechStacks,
	})
}

func (s *Service) GetLatestByCompanyID(ctx context.Context, companyID int64) (Dossier, error) {
	if s == nil || s.repo == nil {
		return Dossier{}, errors.New("dossiers repository is not configured")
	}
	return s.repo.GetLatestByCompanyID(ctx, companyID)
}

func fallbackResult(company companies.Company) llmResult {
	summary := fmt.Sprintf("%s is a company to research further.", company.OfficialName)
	if company.Website != "" {
		summary = fmt.Sprintf("%s appears to operate through %s and is ready for deeper dossier research.", company.OfficialName, company.Website)
	}

	whatItDoes := fmt.Sprintf("The exact offering for %s still needs validation from official sources.", company.OfficialName)
	if company.ATSProvider != "" {
		whatItDoes = fmt.Sprintf("%s uses %s for hiring, which suggests an active recruiting workflow to inspect next.", company.OfficialName, company.ATSProvider)
	}

	targetCustomers := []string{"To be confirmed from official sources"}
	productAreas := []string{"Hiring and company profile research pending"}
	businessModelClues := []string{"Business model needs confirmation from official website or tech blog"}
	if company.ATSURL != "" {
		businessModelClues = append(businessModelClues, "Public ATS presence suggests active recruiting")
	}

	return llmResult{
		CareersURL:         deriveCareersURL(company),
		CompanySummary:     summary,
		WhatCompanyDoes:    whatItDoes,
		TargetCustomers:    targetCustomers,
		ProductAreas:       productAreas,
		BusinessModelClues: businessModelClues,
		MajorTechStacks: MajorTechStacks{
			Languages:      []string{},
			Frontend:       []string{},
			Backend:        []string{},
			Infrastructure: []string{},
			Data:           []string{},
			Tooling:        []string{},
		},
	}
}

func sanitizeResult(result llmResult, company companies.Company) llmResult {
	result.CareersURL = sanitizeURL(result.CareersURL)
	result.CompanySummary = strings.TrimSpace(result.CompanySummary)
	result.WhatCompanyDoes = strings.TrimSpace(result.WhatCompanyDoes)
	result.TargetCustomers = sanitizeList(result.TargetCustomers)
	result.ProductAreas = sanitizeList(result.ProductAreas)
	result.BusinessModelClues = sanitizeList(result.BusinessModelClues)
	result.MajorTechStacks = sanitizeTechStacks(result.MajorTechStacks)

	if result.CareersURL == "" {
		result.CareersURL = deriveCareersURL(company)
	}
	if result.CompanySummary == "" {
		result.CompanySummary = fallbackResult(company).CompanySummary
	}
	if result.WhatCompanyDoes == "" {
		result.WhatCompanyDoes = fallbackResult(company).WhatCompanyDoes
	}
	if len(result.TargetCustomers) == 0 {
		result.TargetCustomers = fallbackResult(company).TargetCustomers
	}
	if len(result.ProductAreas) == 0 {
		result.ProductAreas = fallbackResult(company).ProductAreas
	}
	if len(result.BusinessModelClues) == 0 {
		result.BusinessModelClues = fallbackResult(company).BusinessModelClues
	}

	return result
}

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
	base.MajorTechStacks = mergeTechStacks(base.MajorTechStacks, override.MajorTechStacks)
	return base
}

func sanitizeList(values []string) []string {
	cleaned := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		cleaned = append(cleaned, trimmed)
	}
	return cleaned
}

func sanitizeTechStacks(stacks MajorTechStacks) MajorTechStacks {
	stacks.Languages = sanitizeList(stacks.Languages)
	stacks.Frontend = sanitizeList(stacks.Frontend)
	stacks.Backend = sanitizeList(stacks.Backend)
	stacks.Infrastructure = sanitizeList(stacks.Infrastructure)
	stacks.Data = sanitizeList(stacks.Data)
	stacks.Tooling = sanitizeList(stacks.Tooling)
	return stacks
}

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

func marshalJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

const dossierSystemPrompt = `You generate a company dossier from confirmed company details.
Return valid JSON only.
Do not include markdown.
Prefer omission over guessing.
Only include technologies explicitly mentioned or strongly evidenced by official sources such as official engineering blogs, developer docs, or careers content.`

const dossierUserPrompt = `Generate one JSON object with exactly these keys:
- careers_url
- company_summary
- what_the_company_does
- target_customers
- product_areas
- business_model_clues
- major_tech_stacks

Company details:
- official_name: %q
- website: %q
- ats_url: %q
- ats_provider: %q

Rules:
- company_summary should be 3 to 6 sentences
- target_customers, product_areas, business_model_clues must be arrays of strings
- major_tech_stacks must be an object with keys: languages, frontend, backend, infrastructure, data, tooling
- only include URLs if they are plausible official URLs
- leave fields empty rather than guess`
