package communications

// Defines communication domain models, service dependencies, and constructor wiring.

import (
	"context"
	"errors"
	"time"

	"github.com/ngochoang/career-planner/internal/sources/llm"
)

// Thread is a communication conversation associated with one person.
type Thread struct {
	ID               int64
	PersonID         int64
	PersonName       string
	PersonNotes      string
	Channel          string
	Subject          string
	Status           string
	Summary          string
	SummaryUpdatedAt *time.Time
	LastActivityAt   time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// Entry is one inbound message, outbound message, or private note within a thread.
type Entry struct {
	ID         int64
	ThreadID   int64
	Direction  string
	Content    string
	OccurredAt time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// ThreadDetail combines a thread with its ordered entries for display and LLM prompts.
type ThreadDetail struct {
	Thread  Thread
	Entries []Entry
}

// CreateThreadInput contains the user-provided values required to open a thread.
type CreateThreadInput struct {
	PersonID   int64
	Channel    string
	Subject    string
	OccurredAt time.Time
}

// UpdateThreadInput contains the editable fields for an existing communication thread.
type UpdateThreadInput struct {
	ThreadID int64
	Channel  string
	Subject  string
}

// CreateEntryInput contains the data required to append a communication entry to a thread.
type CreateEntryInput struct {
	ThreadID   int64
	Direction  string
	Content    string
	OccurredAt time.Time
}

// UpdateSummaryInput contains the generated summary and timestamps persisted on a thread.
type UpdateSummaryInput struct {
	ThreadID         int64
	Summary          string
	SummaryUpdatedAt time.Time
	LastActivityAt   time.Time
}

// GenerateMessageInput identifies the thread context and drafting goal for LLM output.
type GenerateMessageInput struct {
	ThreadID int64
	Goal     string
}

// Repository defines the storage operations required by the communications service.
type Repository interface {
	Count(ctx context.Context) (int, error)
	CreateThread(ctx context.Context, input CreateThreadInput) (Thread, error)
	CreateEntry(ctx context.Context, input CreateEntryInput) (Entry, error)
	DeleteEntry(ctx context.Context, id int64) error
	GetThreadByID(ctx context.Context, id int64) (Thread, error)
	GetThreadDetail(ctx context.Context, id int64) (ThreadDetail, error)
	ListThreadsByPersonID(ctx context.Context, personID int64) ([]Thread, error)
	UpdateThread(ctx context.Context, input UpdateThreadInput) (Thread, error)
	UpdateThreadStatus(ctx context.Context, threadID int64, status string) (Thread, error)
	UpdateThreadSummary(ctx context.Context, input UpdateSummaryInput) (Thread, error)
}

// Service validates communication data, persists it, and optionally invokes the LLM client.
type Service struct {
	repo   Repository
	client llm.Client
}

var (
	// ErrThreadNotFound reports that the requested communication thread does not exist.
	ErrThreadNotFound = errors.New("communication thread not found")
	// ErrEntryNotFound reports that the requested communication entry does not exist.
	ErrEntryNotFound = errors.New("communication entry not found")
	// ErrInvalidGoal reports that a message generation goal is unsupported.
	ErrInvalidGoal = errors.New("invalid communication goal")
	// ErrInvalidStatus reports that a thread status is unsupported.
	ErrInvalidStatus = errors.New("invalid communication status")
)

// NewService constructs a communications service with required storage and optional LLM support.
func NewService(repo Repository, client llm.Client) *Service {
	if repo == nil {
		panic("communications repository is required")
	}
	return &Service{repo: repo, client: client}
}
