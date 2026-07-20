package people

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"
)

type Person struct {
	ID          int64
	FullName    string
	Title       string
	CompanyID   int64
	CompanyName string
	LinkedInURL string
	Notes       string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type CreatePersonInput struct {
	FullName    string
	Title       string
	CompanyID   int64
	LinkedInURL string
	Notes       string
}

type Repository interface {
	Count(ctx context.Context) (int, error)
	Create(ctx context.Context, input CreatePersonInput) (Person, error)
	GetByID(ctx context.Context, id int64) (Person, error)
	List(ctx context.Context) ([]Person, error)
}

type Service struct {
	repo Repository
}

func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

func (s *Service) Create(ctx context.Context, input CreatePersonInput) (Person, error) {
	if s == nil || s.repo == nil {
		return Person{}, errors.New("people repository is not configured")
	}

	input.FullName = strings.TrimSpace(input.FullName)
	input.Title = strings.TrimSpace(input.Title)
	input.LinkedInURL = sanitizeURL(input.LinkedInURL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.CompanyID < 0 {
		input.CompanyID = 0
	}

	if input.FullName == "" {
		return Person{}, errors.New("full name is required")
	}

	return s.repo.Create(ctx, input)
}

func (s *Service) List(ctx context.Context) ([]Person, error) {
	if s == nil || s.repo == nil {
		return nil, errors.New("people repository is not configured")
	}
	return s.repo.List(ctx)
}

func (s *Service) Count(ctx context.Context) (int, error) {
	if s == nil || s.repo == nil {
		return 0, errors.New("people repository is not configured")
	}
	return s.repo.Count(ctx)
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
