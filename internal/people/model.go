package people

// Domain types exchanged with the local-first RPC surface. Persistence lives
// in the browser — this package only formats prompts and returns LLM output
// for thread summaries and outbound message drafts.

import (
	"errors"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// Person carries the identifying fields other packages need when composing
// LLM prompts. The browser owns person persistence — this struct is a
// wire/argument type, not a stored record.
type Person struct {
	Name  string
	Notes string
}

// Thread carries the identifying and status fields the browser sends in a
// summarize/generate RPC request. IDs and timestamps stay in the browser DB.
type Thread struct {
	Person  Person
	Channel string
	Subject string
	Status  string
	Summary string
}

// ThreadEntry is one message or note within a thread — the caller supplies
// the direction, content, and occurrence time.
type ThreadEntry struct {
	Direction  string
	Content    string
	OccurredAt time.Time
}

// ThreadDetail combines a thread with its ordered entries for LLM prompts.
type ThreadDetail struct {
	Thread  Thread
	Entries []ThreadEntry
}

// Service exposes LLM-backed thread summarization and message drafting.
type Service struct {
	client llm.Client
}

// MessageGoals is the set of supported goals for GenerateMessageFromContext.
// A membership check on a normalized goal string gates message generation.
var MessageGoals = map[string]struct{}{
	"outreach": {},
	"reply":    {},
}

// ErrInvalidGoal reports that a message generation goal is unsupported.
var ErrInvalidGoal = errors.New("invalid communication goal")

// NewService constructs a people service (thread summaries + message drafts).
func NewService(client llm.Client) *Service {
	return &Service{client: client}
}
