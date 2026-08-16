package communications

// Stateless LLM helpers for thread summaries and outbound message drafts.
// Data is supplied by the browser; nothing here touches a database.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// Directions lists the supported entry directions. Used server-side by
// entryActorLabel to validate direction tokens when building thread prompts.
// The browser's copy of this list lives in web/static/db/enums.json —
// TestDirectionsMatchEnumsJSON guards against drift.
var Directions = []string{"inbound", "outbound", "note"}

var allowedDirections = sliceToSet(Directions)

var ErrUnsafeGeneration = errors.New("could not safely generate a result from this thread")

func sliceToSet(vals []string) map[string]struct{} {
	set := make(map[string]struct{}, len(vals))
	for _, v := range vals {
		set[v] = struct{}{}
	}
	return set
}

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
	if s.client == nil {
		return "", fmt.Errorf("llm client is not configured")
	}
	set := llm.PickPromptSet(summarizePrompts(), outputLanguage)
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
	if s.client == nil {
		return "", fmt.Errorf("llm client is not configured")
	}
	set := llm.PickPromptSet(messagePrompts(), outputLanguage)
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

// buildThreadContext formats thread, person-note, summary, and entry data for
// LLM prompts. Each entry line stamps the concrete actor ("from Jane Doe to
// me" etc.) rather than the raw direction token so the LLM can attribute
// statements without decoding jargon.
//
// Channel and Status are sanitized via llm.SanitizeText — a hostile browser
// bypassing the enum dropdowns could otherwise smuggle prompt-injection
// content in through those short label fields. Suspicious values collapse
// to empty rather than reaching the LLM.
func buildThreadContext(detail ThreadDetail) string {
	personName := strings.TrimSpace(detail.Thread.Person.Name)
	if personName == "" {
		personName = "the person"
	}
	parts := []string{
		fmt.Sprintf("Person: %s", personName),
		fmt.Sprintf("Channel: %s", llm.SanitizeText(detail.Thread.Channel)),
		fmt.Sprintf("Subject: %s", detail.Thread.Subject),
		fmt.Sprintf("Status: %s", llm.SanitizeText(detail.Thread.Status)),
		"Entry order: newest first.",
	}
	if strings.TrimSpace(detail.Thread.Person.Notes) != "" {
		parts = append(parts, fmt.Sprintf("Background notes: %s", strings.TrimSpace(detail.Thread.Person.Notes)))
	}
	if strings.TrimSpace(detail.Thread.Summary) != "" {
		parts = append(parts, fmt.Sprintf("Existing summary: %s", detail.Thread.Summary))
	}
	parts = append(parts, "Entries:")
	for _, entry := range detail.Entries {
		parts = append(parts, fmt.Sprintf("- %s | %s | %s",
			entry.OccurredAt.Format(time.RFC3339),
			entryActorLabel(entry.Direction, personName),
			strings.TrimSpace(entry.Content),
		))
	}
	return strings.Join(parts, "\n")
}

func entryActorLabel(direction, personName string) string {
	direction = strings.TrimSpace(strings.ToLower(direction))
	if _, ok := allowedDirections[direction]; !ok {
		direction = "note"
	}
	switch direction {
	case "inbound":
		return fmt.Sprintf("from %s to me", personName)
	case "outbound":
		return fmt.Sprintf("from me to %s", personName)
	default:
		// Emphatic phrasing — LLMs otherwise pattern-match notes into the
		// "from me to <person>" narrative because the person is the thread
		// subject. Spell out that a note has no recipient.
		return fmt.Sprintf("my personal note (NOT sent to %s, NOT sent to anyone)", personName)
	}
}
