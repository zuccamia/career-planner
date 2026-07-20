package companies

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/ngochoang/career-planner/internal/llm"
)

type Candidate struct {
	OfficialName string  `json:"official_name"`
	Website      string  `json:"website"`
	TechBlogURL  string  `json:"tech_blog_url"`
	ATSURL       string  `json:"ats_url"`
	ATSProvider  string  `json:"ats_provider"`
	Confidence   float64 `json:"confidence"`
	Reasoning    string  `json:"reasoning"`
}

type Company struct {
	ID            int64
	SubmittedName string
	OfficialName  string
	Website       string
	TechBlogURL   string
	ATSURL        string
	ATSProvider   string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type CreateCompanyInput struct {
	SubmittedName string
	OfficialName  string
	Website       string
	TechBlogURL   string
	ATSURL        string
	ATSProvider   string
}

type UpdateCompanyInput struct {
	ID           int64
	OfficialName string
	Website      string
	TechBlogURL  string
	ATSURL       string
	ATSProvider  string
}

var ErrCompanyNotFound = errors.New("company not found")

type Repository interface {
	Count(ctx context.Context) (int, error)
	Create(ctx context.Context, input CreateCompanyInput) (Company, error)
	Delete(ctx context.Context, id int64) error
	GetByID(ctx context.Context, id int64) (Company, error)
	List(ctx context.Context) ([]Company, error)
	Update(ctx context.Context, input UpdateCompanyInput) (Company, error)
}

type Service struct {
	client llm.Client
	repo   Repository
}

func NewService(client llm.Client, repo Repository) *Service {
	return &Service{client: client, repo: repo}
}

func (s *Service) GuessCandidate(ctx context.Context, input string) (Candidate, error) {
	trimmed := strings.TrimSpace(input)
	fallback := Candidate{OfficialName: trimmed}
	if trimmed == "" {
		return fallback, nil
	}
	if s == nil || s.client == nil {
		return fallback, nil
	}

	prompt := llm.Prompt{
		System: companyCandidateSystemPrompt,
		User:   fmt.Sprintf(companyCandidateUserPrompt, trimmed),
	}

	var candidate Candidate
	if err := s.client.GenerateJSON(ctx, prompt, &candidate); err != nil {
		return fallback, err
	}

	candidate = sanitizeCandidate(candidate, trimmed)
	if candidate.OfficialName == "" {
		candidate.OfficialName = trimmed
	}
	return candidate, nil
}

func sanitizeCandidate(candidate Candidate, fallbackName string) Candidate {
	candidate.OfficialName = strings.TrimSpace(candidate.OfficialName)
	candidate.Website = sanitizeURL(candidate.Website)
	candidate.TechBlogURL = sanitizeURL(candidate.TechBlogURL)
	candidate.ATSURL = sanitizeURL(candidate.ATSURL)
	candidate.ATSProvider = strings.TrimSpace(candidate.ATSProvider)
	candidate.Reasoning = strings.TrimSpace(candidate.Reasoning)
	if candidate.Confidence < 0 {
		candidate.Confidence = 0
	}
	if candidate.Confidence > 1 {
		candidate.Confidence = 1
	}
	if candidate.OfficialName == "" {
		candidate.OfficialName = fallbackName
	}
	return candidate
}

func sanitizeURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	return parsed.String()
}

func (s *Service) Create(ctx context.Context, input CreateCompanyInput) (Company, error) {
	if s == nil || s.repo == nil {
		return Company{}, errors.New("companies repository is not configured")
	}

	input.SubmittedName = strings.TrimSpace(input.SubmittedName)
	input.OfficialName = strings.TrimSpace(input.OfficialName)
	input.Website = sanitizeURL(input.Website)
	input.TechBlogURL = sanitizeURL(input.TechBlogURL)
	input.ATSURL = sanitizeURL(input.ATSURL)
	input.ATSProvider = strings.TrimSpace(input.ATSProvider)

	if input.SubmittedName == "" {
		return Company{}, errors.New("submitted company name is required")
	}
	if input.OfficialName == "" {
		input.OfficialName = input.SubmittedName
	}

	return s.repo.Create(ctx, input)
}

func (s *Service) GetByID(ctx context.Context, id int64) (Company, error) {
	if s == nil || s.repo == nil {
		return Company{}, errors.New("companies repository is not configured")
	}
	if id <= 0 {
		return Company{}, ErrCompanyNotFound
	}
	return s.repo.GetByID(ctx, id)
}

func (s *Service) List(ctx context.Context) ([]Company, error) {
	if s == nil || s.repo == nil {
		return nil, errors.New("companies repository is not configured")
	}
	return s.repo.List(ctx)
}

func (s *Service) Count(ctx context.Context) (int, error) {
	if s == nil || s.repo == nil {
		return 0, errors.New("companies repository is not configured")
	}
	return s.repo.Count(ctx)
}

func (s *Service) Delete(ctx context.Context, id int64) error {
	if s == nil || s.repo == nil {
		return errors.New("companies repository is not configured")
	}
	if id <= 0 {
		return ErrCompanyNotFound
	}
	return s.repo.Delete(ctx, id)
}

func (s *Service) Update(ctx context.Context, input UpdateCompanyInput) (Company, error) {
	if s == nil || s.repo == nil {
		return Company{}, errors.New("companies repository is not configured")
	}
	if input.ID <= 0 {
		return Company{}, ErrCompanyNotFound
	}

	input.OfficialName = strings.TrimSpace(input.OfficialName)
	input.Website = sanitizeURL(input.Website)
	input.TechBlogURL = sanitizeURL(input.TechBlogURL)
	input.ATSURL = sanitizeURL(input.ATSURL)
	input.ATSProvider = strings.TrimSpace(input.ATSProvider)

	if input.OfficialName == "" {
		return Company{}, errors.New("official company name is required")
	}

	return s.repo.Update(ctx, input)
}

const companyCandidateSystemPrompt = `You identify one best-effort company candidate from a user-provided company name.
Return valid JSON only.
Do not include markdown.
Prefer incomplete fields over guessing.
Prefer the official company website over directory or profile sites.
If the ATS URL or ATS provider is uncertain, leave it empty.`

const companyCandidateUserPrompt = `Company name entered by user: %q

Return exactly one JSON object with these keys:
- official_name
- website
- tech_blog_url
- ats_url
- ats_provider
- confidence
- reasoning

Rules:
- confidence must be a number between 0 and 1
- leave website empty if uncertain
- leave tech_blog_url empty if uncertain
- leave ats_url empty if uncertain
- leave ats_provider empty if uncertain
- prefer partial accuracy over hallucination`
