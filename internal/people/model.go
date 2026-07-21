package people

// Defines person domain types and service dependencies.

import (
	"context"
	"errors"
	"time"
)

// Person is the persisted contact record used throughout the application.
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

// CreatePersonInput contains the validated fields required to create a person.
type CreatePersonInput struct {
	FullName    string
	Title       string
	CompanyID   int64
	LinkedInURL string
	Notes       string
}

// UpdatePersonInput contains the editable fields for an existing person.
type UpdatePersonInput struct {
	ID          int64
	FullName    string
	Title       string
	CompanyID   int64
	LinkedInURL string
	Notes       string
}

var ErrPersonNotFound = errors.New("person not found")

// Repository defines the storage operations required by the people service.
type Repository interface {
	Count(ctx context.Context) (int, error)
	Create(ctx context.Context, input CreatePersonInput) (Person, error)
	Delete(ctx context.Context, id int64) error
	GetByID(ctx context.Context, id int64) (Person, error)
	List(ctx context.Context) ([]Person, error)
	Update(ctx context.Context, input UpdatePersonInput) (Person, error)
}

// Service applies validation before delegating to the repository.
type Service struct {
	repo Repository
}

// NewService constructs a people service with the required repository dependency.
func NewService(repo Repository) *Service {
	if repo == nil {
		panic("people repository is required")
	}
	return &Service{repo: repo}
}
