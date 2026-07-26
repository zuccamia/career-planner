package dossiers

// Dossier types and service handle. Persistence lives in the browser now —
// this package composes LLM output + fallbacks and returns the result for
// the RPC layer to pass back.

import (
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// MajorTechStacks groups the main technologies evidenced for a company by category.
type MajorTechStacks struct {
	Languages      []string `json:"languages"`
	Frontend       []string `json:"frontend"`
	Backend        []string `json:"backend"`
	Infrastructure []string `json:"infrastructure"`
	Data           []string `json:"data"`
	Tooling        []string `json:"tooling"`
}

// Dossier is a generated company research summary returned to the browser,
// which owns persistence (IDs and timestamps live there).
type Dossier struct {
	Status                string          `json:"status"`
	CareersURL            string          `json:"careers_url"`
	CompanySummary        string          `json:"company_summary"`
	WhatTheCompanyDoes    string          `json:"what_the_company_does"`
	TargetCustomers       []string        `json:"target_customers"`
	ProductAreas          []string        `json:"product_areas"`
	BusinessModelClues    []string        `json:"business_model_clues"`
	RecentProductLaunches []string        `json:"recent_product_launches"`
	CompanyCultureNotes   []string        `json:"company_culture_notes"`
	HasInternships        bool            `json:"has_internships"`
	InternshipSeasons     []string        `json:"internship_seasons"`
	InternshipSummary     string          `json:"internship_summary"`
	MajorTechStacks       MajorTechStacks `json:"major_tech_stacks"`
	Reasoning             string          `json:"reasoning"`
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
	Reasoning             string          `json:"reasoning"`
}

// Service composes fallback + LLM-augmented dossiers for the local-first client.
type Service struct {
	client llm.Client
}

// NewService constructs a dossier service. A nil client falls back to the
// derived-only dossier (no LLM enrichment).
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}
