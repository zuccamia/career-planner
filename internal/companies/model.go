package companies

// Defines company domain types and service dependencies.

import (
	"context"
	"errors"
	"time"

	"github.com/ngochoang/career-planner/internal/llm"
)

// Candidate holds the tentative company details suggested before a record is saved.
type Candidate struct {
	OfficialName string `json:"official_name"`
	Website      string `json:"website"`
	TechBlogURL  string `json:"tech_blog_url"`
	ATSURL       string `json:"ats_url"`
	ATSProvider  string `json:"ats_provider"`
	Reasoning    string `json:"reasoning"`
}

// Company is the persisted company record used throughout the application.
type Company struct {
	ID           int64
	OfficialName string
	Website      string
	TechBlogURL  string
	ATSURL       string
	ATSProvider  string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// CreateCompanyInput contains the validated fields required to create a company.
type CreateCompanyInput struct {
	OfficialName string
	Website      string
	TechBlogURL  string
	ATSURL       string
	ATSProvider  string
}

// UpdateCompanyInput contains the editable fields for an existing company.
type UpdateCompanyInput struct {
	ID           int64
	OfficialName string
	Website      string
	TechBlogURL  string
	ATSURL       string
	ATSProvider  string
}

var ErrCompanyNotFound = errors.New("company not found")

// Repository defines the storage operations required by the companies service.
type Repository interface {
	Count(ctx context.Context) (int, error)
	Create(ctx context.Context, input CreateCompanyInput) (Company, error)
	Delete(ctx context.Context, id int64) error
	GetByID(ctx context.Context, id int64) (Company, error)
	List(ctx context.Context) ([]Company, error)
	Update(ctx context.Context, input UpdateCompanyInput) (Company, error)
}

// Service applies validation and LLM-assisted enrichment before delegating to the repository.
type Service struct {
	client llm.Client
	repo   Repository
}

// NewService constructs a companies service with the required repository dependency.
func NewService(client llm.Client, repo Repository) *Service {
	if repo == nil {
		panic("companies repository is required")
	}
	return &Service{client: client, repo: repo}
}
