package people

// Stateless LLM helpers for thread summaries and outbound message drafts.
// Data is supplied by the browser; nothing here touches a database.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// Directions lists the supported entry directions. Used server-side by
// entryActorLabel to validate direction tokens when building thread prompts.
// The browser's copy of this list lives in web/static/db/enums.json —
// TestDirectionsMatchEnumsJSON guards against drift.
var Directions = []string{"inbound", "outbound", "note"}

var allowedDirections = sliceToSet(Directions)

var ErrUnsafeGeneration = errors.New("could not safely generate a result from this thread")

// SummaryResult is the raw decoded shape of the summarize prompt response.
type SummaryResult struct {
	Summary string `json:"summary"`
}

// MessageResult is the raw decoded shape of the generate-message prompt response.
type MessageResult struct {
	Message string `json:"message"`
}

// SummarizeThreadContext runs the summary prompt and returns the summary text.
func (s *Service) SummarizeThreadContext(ctx context.Context, detail ThreadDetail, outputLanguage string) (string, error) {
	if err := llm.RequireClient(s.client); err != nil { return "", err }
	set := llm.PickPromptSet(summarizeThreadPrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, buildThreadContext(detail)),
	}
	var out SummaryResult
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return "", err
	}
	summary := llm.SanitizeText(out.Summary)
	if summary == "" {
		return "", ErrUnsafeGeneration
	}
	return summary, nil
}

// GenerateMessageFromContext drafts a message ("outreach" or "reply") from a
// browser-supplied ThreadDetail.
func (s *Service) GenerateMessageFromContext(ctx context.Context, detail ThreadDetail, goal, outputLanguage string) (string, error) {
	goal = strings.TrimSpace(strings.ToLower(goal))
	if _, ok := MessageGoals[goal]; !ok {
		return "", ErrInvalidGoal
	}
	if err := llm.RequireClient(s.client); err != nil { return "", err }
	set := llm.PickPromptSet(generateMessagePrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, goal, buildThreadContext(detail)),
	}
	var out MessageResult
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return "", err
	}
	message := llm.SanitizeText(out.Message)
	if message == "" {
		return "", ErrUnsafeGeneration
	}
	return message, nil
}
