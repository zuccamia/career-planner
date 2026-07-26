package communications

// Domain types exchanged with the local-first RPC surface. Persistence lives
// in the browser — this package only formats prompts and returns LLM output.

import (
	"errors"
	"time"

	"github.com/ngochoang/career-planner/internal/people"
	"github.com/ngochoang/career-planner/internal/sources/llm"
)

// Thread carries the identifying and status fields the browser sends in a
// summarize/generate RPC request. IDs and timestamps stay in the browser DB.
type Thread struct {
	Person  people.Person
	Channel string
	Subject string
	Status  string
	Summary string
}

// Entry is one message or note within a thread — the caller supplies the
// direction, content, and occurrence time.
type Entry struct {
	Direction  string
	Content    string
	OccurredAt time.Time
}

// ThreadDetail combines a thread with its ordered entries for LLM prompts.
type ThreadDetail struct {
	Thread  Thread
	Entries []Entry
}

// Service exposes LLM-backed thread summarization and message drafting.
type Service struct {
	client llm.Client
}

// ErrInvalidGoal reports that a message generation goal is unsupported.
var ErrInvalidGoal = errors.New("invalid communication goal")

// NewService constructs a communications service.
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}
