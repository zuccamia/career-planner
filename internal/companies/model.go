package companies

// Domain types and service handle for the company LLM helpers used by the
// local-first RPC surface. The browser owns persistence — this package no
// longer talks to a database.

import "github.com/zuccamia/career-planner/internal/sources/llm"

// Service exposes LLM-backed helpers for the local-first company flow:
// candidate lookup and dossier generation. A nil client is allowed and
// causes candidate helpers to return unenriched fallbacks; Build errors
// out (dossiers require the LLM).
type Service struct {
	client llm.Client
}

// NewService constructs a companies service.
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}

// =============================================================================
// Candidate lookup
// =============================================================================

// Candidate is the LLM's tentative company inference, returned to the browser
// before the user confirms and stores it locally.
type Candidate struct {
	OfficialName string `json:"official_name"`
	Website      string `json:"website"`
	BlogURL      string `json:"blog_url"`
	ATSURL       string `json:"ats_url"`
	ATSProvider  string `json:"ats_provider"`
	Reasoning    string `json:"reasoning"`
}

// Company carries the identifying fields other packages need when composing
// LLM prompts (e.g. dossiers). It intentionally omits IDs and timestamps —
// those live in the browser DB.
type Company struct {
	OfficialName string
	Website      string
	BlogURL      string
	ATSURL       string
	ATSProvider  string
}

// =============================================================================
// Dossier
// =============================================================================

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

// dossierLLMResult is the raw shape decoded from the LLM before sanitizeResult
// normalizes it and finalizeDossier maps it into a Dossier.
type dossierLLMResult struct {
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

// ScrapedContentMaxBytes caps each scraped block folded into the dossier
// prompt. With up to three blocks (website + blog + careers) this bounds the
// total scraped context to ~36KB — comfortable inside small LLM windows
// alongside the system + user prompt without truncating the response budget.
const ScrapedContentMaxBytes = 12000

// Pages carries optional pre-scraped markdown for each of the three URLs the
// dossier prompt can consume. Empty fields are omitted from the prompt
// entirely (no empty header). Callers scrape URLs they care about and pass
// through only what succeeded — this struct is a pure carrier, not a scraper.
type Pages struct {
	Website string
	Blog    string
	Careers string
}
