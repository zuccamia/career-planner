package engineering_blogs

// Validates and normalizes engineering blog note data before persistence.

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/ngochoang/career-planner/internal/shared"
)

// Create sanitizes user input and persists a new engineering blog note.
func (s *Service) Create(ctx context.Context, input CreateInput) (Note, error) {
	input.CompanyID = shared.NonNegativeInt64(input.CompanyID)
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

// ListByCompanyID returns notes for one company when the identifier is valid.
func (s *Service) ListByCompanyID(ctx context.Context, companyID int64) ([]Note, error) {
	if companyID <= 0 {
		return []Note{}, nil
	}
	return s.repo.ListByCompanyID(ctx, companyID)
}

// List returns all engineering blog notes from storage.
func (s *Service) List(ctx context.Context) ([]Note, error) {
	return s.repo.List(ctx)
}

// Count returns the number of persisted engineering blog notes.
func (s *Service) Count(ctx context.Context) (int, error) {
	return s.repo.Count(ctx)
}

// GetByID returns one engineering blog note when the identifier is valid.
func (s *Service) GetByID(ctx context.Context, id int64) (Note, error) {
	if id <= 0 {
		return Note{}, errors.New("engineering blog note is required")
	}
	return s.repo.GetByID(ctx, id)
}

// Update sanitizes user input and persists changes to an existing engineering blog note.
func (s *Service) Update(ctx context.Context, input UpdateInput) (Note, error) {
	input.ID = shared.NonNegativeInt64(input.ID)
	input.CompanyID = shared.NonNegativeInt64(input.CompanyID)
	input.URL = sanitizeURL(input.URL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.ID <= 0 {
		return Note{}, errors.New("engineering blog note is required")
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

// Delete removes an engineering blog note when the identifier is valid.
func (s *Service) Delete(ctx context.Context, id int64) error {
	if id <= 0 {
		return errors.New("engineering blog note is required")
	}
	return s.repo.Delete(ctx, id)
}

// ListCompanyCounts returns each company with its engineering blog note total.
func (s *Service) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	return s.repo.ListCompanyCounts(ctx)
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

