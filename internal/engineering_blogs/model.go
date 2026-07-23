package engineering_blogs

// Defines engineering blog note domain types and service dependencies.

import (
	"context"
	"errors"
	"time"
)

// ErrNoteNotFound reports that the requested engineering blog note does not exist.
var ErrNoteNotFound = errors.New("engineering blog note not found")

// Note is a persisted engineering blog article note associated with a company.
type Note struct {
	ID          int64
	CompanyID   int64
	CompanyName string
	URL         string
	Notes       string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// CreateInput contains the validated fields required to create an engineering blog note.
type CreateInput struct {
	CompanyID int64
	URL       string
	Notes     string
}

// UpdateInput contains the editable fields for an existing engineering blog note.
type UpdateInput struct {
	ID        int64
	CompanyID int64
	URL       string
	Notes     string
}

// CompanyCount summarizes how many engineering blog notes belong to one company.
type CompanyCount struct {
	CompanyID   int64
	CompanyName string
	NoteCount   int64
}

// DailyCount summarizes how many records matched on one calendar day.
type DailyCount struct {
	Day   time.Time
	Count int
}

// Repository defines the storage operations required by the engineering blogs service.
type Repository interface {
	Count(ctx context.Context) (int, error)
	Create(ctx context.Context, input CreateInput) (Note, error)
	Delete(ctx context.Context, id int64) error
	GetByID(ctx context.Context, id int64) (Note, error)
	List(ctx context.Context) ([]Note, error)
	ListDailyCreatedCounts(ctx context.Context, from, to time.Time) ([]DailyCount, error)
	ListCompanyCounts(ctx context.Context) ([]CompanyCount, error)
	ListByCompanyID(ctx context.Context, companyID int64) ([]Note, error)
	Update(ctx context.Context, input UpdateInput) (Note, error)
}

// Service applies validation before delegating engineering blog note operations to the repository.
type Service struct {
	repo Repository
}

// NewService constructs an engineering blogs service with the required repository dependency.
func NewService(repo Repository) *Service {
	if repo == nil {
		panic("engineering blogs repository is required")
	}
	return &Service{repo: repo}
}
