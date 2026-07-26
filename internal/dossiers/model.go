package dossiers

// Defines stored research data and service dependencies.

import (
	"context"
	"errors"
	"time"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/sources/llm"
)

var ErrDossierNotFound = errors.New("dossier not found")

// MajorTechStacks groups the main technologies evidenced for a company by category.
type MajorTechStacks struct {
	Languages      []string `json:"languages"`
	Frontend       []string `json:"frontend"`
	Backend        []string `json:"backend"`
	Infrastructure []string `json:"infrastructure"`
	Data           []string `json:"data"`
	Tooling        []string `json:"tooling"`
}

// Dossier stores a generated company research summary linked to a company record.
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

// BuildInput identifies the company to research when generating a dossier.
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

// Repository defines the persistence operations needed by the dossier service.
type Repository interface {
	Create(ctx context.Context, dossier Dossier) (Dossier, error)
	GetLatestByCompanyID(ctx context.Context, companyID int64) (Dossier, error)
}

// Service generates dossiers from company records and stores the results.
type Service struct {
	client llm.Client
	repo   Repository
}

// NewService constructs a dossier service with optional LLM generation and required storage.
func NewService(client llm.Client, repo Repository) *Service {
	if repo == nil {
		panic("dossiers repository is required")
	}
	return &Service{client: client, repo: repo}
}
