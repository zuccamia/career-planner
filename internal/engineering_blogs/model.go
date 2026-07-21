package engineering_blogs

// Defines engineering blog note domain types and service dependencies.

import (
	"context"
	"errors"
	"time"
)

var ErrNoteNotFound = errors.New("engineering blog note not found")

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
	Count(ctx context.Context) (int, error)
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
	if repo == nil {
		panic("engineering blogs repository is required")
	}
	return &Service{repo: repo}
}
