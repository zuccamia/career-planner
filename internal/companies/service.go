package companies

// Validates and normalizes company data before persistence.

import (
	"context"
	"errors"
	"strings"

	"github.com/ngochoang/career-planner/internal/shared"
)

// Create sanitizes user input and persists a new company.
func (s *Service) Create(ctx context.Context, input CreateCompanyInput) (Company, error) {
	input.OfficialName = strings.TrimSpace(input.OfficialName)
	input.Website = shared.SanitizeHTTPURL(input.Website)
	input.TechBlogURL = shared.SanitizeHTTPURL(input.TechBlogURL)
	input.ATSURL = shared.SanitizeHTTPURL(input.ATSURL)
	input.ATSProvider = strings.TrimSpace(input.ATSProvider)

	if input.OfficialName == "" {
		return Company{}, errors.New("official company name is required")
	}

	return s.repo.Create(ctx, input)
}

// GetByID returns one company when the identifier is valid.
func (s *Service) GetByID(ctx context.Context, id int64) (Company, error) {
	if id <= 0 {
		return Company{}, ErrCompanyNotFound
	}
	return s.repo.GetByID(ctx, id)
}

// List returns all companies from storage.
func (s *Service) List(ctx context.Context) ([]Company, error) {
	return s.repo.List(ctx)
}

// Count returns the number of persisted companies.
func (s *Service) Count(ctx context.Context) (int, error) {
	return s.repo.Count(ctx)
}

// Delete removes a company when the identifier is valid.
func (s *Service) Delete(ctx context.Context, id int64) error {
	if id <= 0 {
		return ErrCompanyNotFound
	}
	return s.repo.Delete(ctx, id)
}

// Update sanitizes user input and persists changes to an existing company.
func (s *Service) Update(ctx context.Context, input UpdateCompanyInput) (Company, error) {
	if input.ID <= 0 {
		return Company{}, ErrCompanyNotFound
	}

	input.OfficialName = strings.TrimSpace(input.OfficialName)
	input.Website = shared.SanitizeHTTPURL(input.Website)
	input.TechBlogURL = shared.SanitizeHTTPURL(input.TechBlogURL)
	input.ATSURL = shared.SanitizeHTTPURL(input.ATSURL)
	input.ATSProvider = strings.TrimSpace(input.ATSProvider)

	if input.OfficialName == "" {
		return Company{}, errors.New("official company name is required")
	}

	return s.repo.Update(ctx, input)
}
