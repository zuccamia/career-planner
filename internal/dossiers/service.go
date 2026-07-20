package dossiers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/llm"
)

var ErrDossierNotFound = errors.New("dossier not found")

var productLaunchPattern = regexp.MustCompile(`^(\d{4}(?:-\d{2}(?:-\d{2})?)?)\s\|\s.+`)

type MajorTechStacks struct {
	Languages      []string `json:"languages"`
	Frontend       []string `json:"frontend"`
	Backend        []string `json:"backend"`
	Infrastructure []string `json:"infrastructure"`
	Data           []string `json:"data"`
	Tooling        []string `json:"tooling"`
}

type Dossier struct {
	ID                    int64
	CompanyID             int64
	Status                string
	CareersURL            string
	CompanySummary        string
	WhatTheCompanyDoes    string
	TargetCustomers       []string
	ProductAreas          []string
	BusinessModelClues    []string
	RecentProductLaunches []string
	CompanyCultureNotes   []string
	HasInternships        bool
	InternshipSeasons     []string
	InternshipSummary     string
	MajorTechStacks       MajorTechStacks
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

type BuildInput struct {
	Company companies.Company
}

type llmResult struct {
	CareersURL            string          `json:"careers_url"`
	CompanySummary        string          `json:"company_summary"`
	WhatCompanyDoes       string          `json:"what_the_company_does"`
	TargetCustomers       []string        `json:"target_customers"`
	ProductAreas          []string        `json:"product_areas"`
	BusinessModelClues    []string        `json:"business_model_clues"`
	RecentProductLaunches []string        `json:"recent_product_launches"`
	CompanyCultureNotes   []string        `json:"company_culture_notes"`
	HasInternships        bool            `json:"has_internships"`
	InternshipSeasons     []string        `json:"internship_seasons"`
	InternshipSummary     string          `json:"internship_summary"`
	MajorTechStacks       MajorTechStacks `json:"major_tech_stacks"`
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
		CareersURL:            deriveCareersURL(company),
		CompanySummary:        summary,
		WhatCompanyDoes:       whatItDoes,
		TargetCustomers:       targetCustomers,
		ProductAreas:          productAreas,
		BusinessModelClues:    businessModelClues,
		RecentProductLaunches: []string{},
		CompanyCultureNotes:   []string{},
		HasInternships:        false,
		InternshipSeasons:     []string{},
		InternshipSummary:     "",
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
	result.RecentProductLaunches = sanitizeProductLaunches(result.RecentProductLaunches)
	result.CompanyCultureNotes = sanitizeList(result.CompanyCultureNotes)
	result.InternshipSeasons = sanitizeInternshipSeasons(result.InternshipSeasons)
	result.InternshipSummary = sanitizeParagraph(result.InternshipSummary)
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
	if len(result.InternshipSeasons) == 0 && result.HasInternships {
		result.InternshipSeasons = []string{"Unspecified"}
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
	if len(override.RecentProductLaunches) > 0 {
		base.RecentProductLaunches = override.RecentProductLaunches
	}
	if len(override.CompanyCultureNotes) > 0 {
		base.CompanyCultureNotes = override.CompanyCultureNotes
	}
	if override.HasInternships {
		base.HasInternships = true
	}
	if len(override.InternshipSeasons) > 0 {
		base.InternshipSeasons = override.InternshipSeasons
	}
	if override.InternshipSummary != "" {
		base.InternshipSummary = override.InternshipSummary
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

func sanitizeURLs(values []string) []string {
	cleaned := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		trimmed := sanitizeURL(value)
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

func sanitizeProductLaunches(values []string) []string {
	cleaned := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		trimmed := strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
		if trimmed == "" {
			continue
		}
		if !productLaunchPattern.MatchString(trimmed) {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		cleaned = append(cleaned, trimmed)
	}
	sort.Slice(cleaned, func(i, j int) bool {
		return cleaned[i] > cleaned[j]
	})
	return cleaned
}

func sanitizeInternshipSeasons(values []string) []string {
	allowed := map[string]string{
		"spring": "Spring",
		"summer": "Summer",
		"fall":   "Fall",
		"winter": "Winter",
	}
	cleaned := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		key := strings.ToLower(strings.TrimSpace(value))
		normalized, ok := allowed[key]
		if !ok {
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

func sanitizeParagraph(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
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
- recent_product_launches
- company_culture_notes
- has_internships
- internship_seasons
- internship_summary
- major_tech_stacks

Company details:
- official_name: %q
- website: %q
- ats_url: %q
- ats_provider: %q

Rules:
- company_summary should be 3 to 6 sentences
- target_customers, product_areas, business_model_clues, recent_product_launches, company_culture_notes, internship_seasons must be arrays of strings
- recent_product_launches should focus on recent notable launches, releases, or major product announcements if evidenced
- each recent_product_launches entry must begin with a date in YYYY-MM-DD, YYYY-MM, or YYYY format and use exactly this format:
  <date> | <launch title> | Product area: <product area> | Target customers: <target customers> | Summary: <brief factual summary>
- company_culture_notes should capture concise, evidence-based observations from company values pages, engineering blogs, or careers pages
- has_internships must be a boolean and only true when there is evidence of internship offerings
- internship_seasons should only include seasons with evidence, such as Spring, Summer, Fall, or Winter
- internship_summary should be 2 to 3 sentences summarizing whether internships exist, which seasons appear supported, and the strength/source of evidence; leave empty rather than guess
- major_tech_stacks must be an object with keys: languages, frontend, backend, infrastructure, data, tooling
- only include URLs if they are plausible official URLs
- leave fields empty rather than guess`
