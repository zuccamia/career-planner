package people

// Validates and normalizes person data before persistence.

import (
	"context"
	"errors"
	"strings"

	"github.com/ngochoang/career-planner/internal/shared"
)

// Create sanitizes user input and persists a new person.
func (s *Service) Create(ctx context.Context, input CreatePersonInput) (Person, error) {
	input.FullName = strings.TrimSpace(input.FullName)
	input.Title = strings.TrimSpace(input.Title)
	input.LinkedInURL = shared.SanitizeHTTPURL(input.LinkedInURL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.CompanyID < 0 {
		input.CompanyID = 0
	}

	if input.FullName == "" {
		return Person{}, errors.New("full name is required")
	}

	return s.repo.Create(ctx, input)
}

// GetByID returns one person when the identifier is valid.
func (s *Service) GetByID(ctx context.Context, id int64) (Person, error) {
	if id <= 0 {
		return Person{}, ErrPersonNotFound
	}
	return s.repo.GetByID(ctx, id)
}

// List returns all people from storage.
func (s *Service) List(ctx context.Context) ([]Person, error) {
	return s.repo.List(ctx)
}

// Count returns the number of persisted people.
func (s *Service) Count(ctx context.Context) (int, error) {
	return s.repo.Count(ctx)
}

// ListCompanyCounts returns each company with its linked people total.
func (s *Service) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	return s.repo.ListCompanyCounts(ctx)
}

// Update sanitizes user input and persists changes to an existing person.
func (s *Service) Update(ctx context.Context, input UpdatePersonInput) (Person, error) {
	if input.ID <= 0 {
		return Person{}, ErrPersonNotFound
	}

	input.FullName = strings.TrimSpace(input.FullName)
	input.Title = strings.TrimSpace(input.Title)
	input.LinkedInURL = shared.SanitizeHTTPURL(input.LinkedInURL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.CompanyID < 0 {
		input.CompanyID = 0
	}

	if input.FullName == "" {
		return Person{}, errors.New("full name is required")
	}

	return s.repo.Update(ctx, input)
}

// Delete removes a person when the identifier is valid.
func (s *Service) Delete(ctx context.Context, id int64) error {
	if id <= 0 {
		return ErrPersonNotFound
	}
	return s.repo.Delete(ctx, id)
}
