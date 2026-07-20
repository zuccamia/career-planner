package engineeringnotes

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"
)

type Note struct {
	ID          int64
	CompanyID   int64
	CompanyName string
	URL         string
	Notes       string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type CreateInput struct {
	CompanyID int64
	URL       string
	Notes     string
}

type UpdateInput struct {
	ID        int64
	CompanyID int64
	URL       string
	Notes     string
}

type CompanyCount struct {
	CompanyID   int64
	CompanyName string
	NoteCount   int64
}

type Repository interface {
	Create(ctx context.Context, input CreateInput) (Note, error)
	Delete(ctx context.Context, id int64) error
	GetByID(ctx context.Context, id int64) (Note, error)
	List(ctx context.Context) ([]Note, error)
	ListCompanyCounts(ctx context.Context) ([]CompanyCount, error)
	ListByCompanyID(ctx context.Context, companyID int64) ([]Note, error)
	Update(ctx context.Context, input UpdateInput) (Note, error)
}

type Service struct {
	repo Repository
}

func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

func (s *Service) Create(ctx context.Context, input CreateInput) (Note, error) {
	if s == nil || s.repo == nil {
		return Note{}, errors.New("engineering notes repository is not configured")
	}
	input.CompanyID = max(input.CompanyID, 0)
	input.URL = sanitizeURL(input.URL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.CompanyID <= 0 {
		return Note{}, errors.New("company is required")
	}
	if input.URL == "" {
		return Note{}, errors.New("article URL is required")
	}
	if input.Notes == "" {
		return Note{}, errors.New("notes are required")
	}
	return s.repo.Create(ctx, input)
}

func (s *Service) ListByCompanyID(ctx context.Context, companyID int64) ([]Note, error) {
	if s == nil || s.repo == nil {
		return nil, errors.New("engineering notes repository is not configured")
	}
	if companyID <= 0 {
		return []Note{}, nil
	}
	return s.repo.ListByCompanyID(ctx, companyID)
}

func (s *Service) List(ctx context.Context) ([]Note, error) {
	if s == nil || s.repo == nil {
		return nil, errors.New("engineering notes repository is not configured")
	}
	return s.repo.List(ctx)
}

func (s *Service) GetByID(ctx context.Context, id int64) (Note, error) {
	if s == nil || s.repo == nil {
		return Note{}, errors.New("engineering notes repository is not configured")
	}
	if id <= 0 {
		return Note{}, errors.New("engineering note is required")
	}
	return s.repo.GetByID(ctx, id)
}

func (s *Service) Update(ctx context.Context, input UpdateInput) (Note, error) {
	if s == nil || s.repo == nil {
		return Note{}, errors.New("engineering notes repository is not configured")
	}
	input.ID = max(input.ID, 0)
	input.CompanyID = max(input.CompanyID, 0)
	input.URL = sanitizeURL(input.URL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.ID <= 0 {
		return Note{}, errors.New("engineering note is required")
	}
	if input.CompanyID <= 0 {
		return Note{}, errors.New("company is required")
	}
	if input.URL == "" {
		return Note{}, errors.New("article URL is required")
	}
	if input.Notes == "" {
		return Note{}, errors.New("notes are required")
	}
	return s.repo.Update(ctx, input)
}

func (s *Service) Delete(ctx context.Context, id int64) error {
	if s == nil || s.repo == nil {
		return errors.New("engineering notes repository is not configured")
	}
	if id <= 0 {
		return errors.New("engineering note is required")
	}
	return s.repo.Delete(ctx, id)
}

func (s *Service) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	if s == nil || s.repo == nil {
		return nil, errors.New("engineering notes repository is not configured")
	}
	return s.repo.ListCompanyCounts(ctx)
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

func max(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
