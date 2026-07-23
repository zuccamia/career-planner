package applications

// Defines application domain types and service dependencies.

import (
	"context"
	"errors"
	"time"

	"github.com/ngochoang/career-planner/internal/sources/llm"
)

// ErrApplicationNotFound reports that the requested application does not exist.
var ErrApplicationNotFound = errors.New("application not found")

// Statuses lists the supported application workflow states in display order.
var Statuses = []string{"wishlist", "applied", "online_assessment", "first_interview", "second_interview", "additional_interview", "offer", "rejected", "withdrawn"}

// Application is the persisted job application record used throughout the application.
type Application struct {
	ID                          int64
	CompanyID                   int64
	CompanyName                 string
	PersonID                    int64
	PersonName                  string
	RoleTitle                   string
	JobPostingURL               string
	JobDescriptionRaw           string
	JobDescriptionExtractedJSON string
	Status                      string
	Notes                       string
	CreatedAt                   time.Time
	UpdatedAt                   time.Time
	LatestEventAt               time.Time
}

// Event is one timeline entry associated with an application.
type Event struct {
	ID            int64
	ApplicationID int64
	Type          string
	Content       string
	FromStatus    string
	ToStatus      string
	OccurredAt    time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// Artifact is one generated or uploaded application asset stored inline or on disk.
type Artifact struct {
	ID            int64
	ApplicationID int64
	Kind          string
	Label         string
	StorageType   string
	FilePath      string
	Content       string
	MimeType      string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// CompanyCount summarizes how many applications belong to one company.
type CompanyCount struct {
	CompanyID        int64
	CompanyName      string
	ApplicationCount int64
}

// DailyCount summarizes how many records matched on one calendar day.
type DailyCount struct {
	Day   time.Time
	Count int
}

// StatusTransitionCount summarizes how many status-change events occurred between two statuses.
type StatusTransitionCount struct {
	FromStatus string
	ToStatus   string
	Count      int
}

// CreateApplicationInput contains the validated fields required to create an application.
type CreateApplicationInput struct {
	CompanyID                   int64
	PersonID                    int64
	RoleTitle                   string
	JobPostingURL               string
	JobDescriptionRaw           string
	JobDescriptionExtractedJSON string
	Status                      string
	Notes                       string
}

// UpdateApplicationInput contains the editable fields for an existing application.
type UpdateApplicationInput struct {
	ID                          int64
	CompanyID                   int64
	PersonID                    int64
	RoleTitle                   string
	JobPostingURL               string
	JobDescriptionRaw           string
	JobDescriptionExtractedJSON string
	Status                      string
	Notes                       string
}

// CreateEventInput contains the user-provided values required to append an application event.
type CreateEventInput struct {
	ApplicationID int64
	Type          string
	Content       string
	FromStatus    string
	ToStatus      string
	OccurredAt    time.Time
}

// UpdateStatusInput contains the values supported by the quick status-update workflow.
type UpdateStatusInput struct {
	ApplicationID int64
	Status        string
	OccurredAt    time.Time
	Notes         string
}

// CreateArtifactInput contains the values required to save one application artifact.
type CreateArtifactInput struct {
	ApplicationID int64
	Kind          string
	Label         string
	StorageType   string
	FilePath      string
	Content       string
	MimeType      string
}

// Repository defines the storage operations required by the applications service.
type Repository interface {
	Count(ctx context.Context) (int, error)
	CountByStatus(ctx context.Context, status string) (int, error)
	Create(ctx context.Context, input CreateApplicationInput) (Application, error)
	CreateArtifact(ctx context.Context, input CreateArtifactInput) (Artifact, error)
	CreateEvent(ctx context.Context, input CreateEventInput) (Event, error)
	Delete(ctx context.Context, id int64) error
	GetByID(ctx context.Context, id int64) (Application, error)
	List(ctx context.Context) ([]Application, error)
	ListCompanyCounts(ctx context.Context) ([]CompanyCount, error)
	ListDailyAppliedCounts(ctx context.Context, from, to time.Time) ([]DailyCount, error)
	ListStatusTransitionCounts(ctx context.Context) ([]StatusTransitionCount, error)
	ListArtifactsByApplicationID(ctx context.Context, applicationID int64) ([]Artifact, error)
	ListEventsByApplicationID(ctx context.Context, applicationID int64) ([]Event, error)
	Update(ctx context.Context, input UpdateApplicationInput) (Application, error)
	UpdateStatus(ctx context.Context, applicationID int64, status string) (Application, error)
	UpdateJobDescriptionRaw(ctx context.Context, applicationID int64, raw string) (Application, error)
	UpdateJobDescriptionExtractedJSON(ctx context.Context, applicationID int64, extractedJSON string) (Application, error)
}

// Service applies validation before delegating to the repository.
type Service struct {
	repo     Repository
	client   llm.Client
	fetchURL func(ctx context.Context, url string) (string, error)
}

// NewService constructs an applications service with the required repository dependency.
func NewService(repo Repository, client llm.Client) *Service {
	if repo == nil {
		panic("applications repository is required")
	}
	return &Service{repo: repo, client: client, fetchURL: fetchJobPostingText}
}
