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

// Channels, Directions, Statuses list the supported enum values in display
// order. Exposed via /api/db/enums.json so the browser matches its dropdowns
// to the same source.
var (
	Channels   = []string{"email", "handshake", "linkedin", "phone", "meeting", "text"}
	Directions = []string{"inbound", "outbound", "note"}
	Statuses   = []string{"open", "closed"}
)

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
// Composed from BuildSummaryPrompt + FinalizeSummary.
func (s *Service) SummarizeThreadContext(ctx context.Context, detail ThreadDetail) (string, error) {
	if s.client == nil {
		return "", fmt.Errorf("llm client is not configured")
	}
	var out SummaryResult
	if err := s.client.GenerateJSON(ctx, s.BuildSummaryPrompt(detail), &out); err != nil {
		return "", err
	}
	summary := s.FinalizeSummary(out)
	if summary == "" {
		return "", ErrUnsafeGeneration
	}
	return summary, nil
}

// GenerateMessageFromContext drafts a message ("outreach" or "reply") from a
// browser-supplied ThreadDetail. Composed from BuildMessagePrompt + FinalizeMessage.
func (s *Service) GenerateMessageFromContext(ctx context.Context, detail ThreadDetail, goal string) (string, error) {
	prompt, err := s.BuildMessagePrompt(detail, goal)
	if err != nil {
		return "", err
	}
	if s.client == nil {
		return "", fmt.Errorf("llm client is not configured")
	}
	var out MessageResult
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return "", err
	}
	message := s.FinalizeMessage(out)
	if message == "" {
		return "", ErrUnsafeGeneration
	}
	return message, nil
}

// BuildSummaryPrompt assembles the summarize prompt for a ThreadDetail. Pure.
func (s *Service) BuildSummaryPrompt(detail ThreadDetail) llm.Prompt {
	return llm.Prompt{
		System: summarizeSystemPrompt,
		User:   fmt.Sprintf(summarizeUserPrompt, buildThreadContext(detail)),
	}
}

// FinalizeSummary trims a decoded summary result.
func (s *Service) FinalizeSummary(out SummaryResult) string {
	return llm.SanitizeText(out.Summary)
}

// BuildMessagePrompt assembles the message-generation prompt. Validates goal.
func (s *Service) BuildMessagePrompt(detail ThreadDetail, goal string) (llm.Prompt, error) {
	goal = strings.TrimSpace(strings.ToLower(goal))
	if goal != "outreach" && goal != "reply" {
		return llm.Prompt{}, ErrInvalidGoal
	}
	return llm.Prompt{
		System: generateSystemPrompt,
		User:   fmt.Sprintf(generateUserPrompt, goal, buildThreadContext(detail)),
	}, nil
}

// FinalizeMessage trims a decoded message result.
func (s *Service) FinalizeMessage(out MessageResult) string {
	return llm.SanitizeText(out.Message)
}

// buildThreadContext formats thread, person-note, summary, and entry data for
// LLM prompts. Each entry line stamps the concrete actor ("from Jane Doe to
// me" etc.) rather than the raw direction token so the LLM can attribute
// statements without decoding jargon.
func buildThreadContext(detail ThreadDetail) string {
	personName := strings.TrimSpace(detail.Thread.Person.Name)
	if personName == "" {
		personName = "the person"
	}
	parts := []string{
		fmt.Sprintf("Person: %s", personName),
		fmt.Sprintf("Channel: %s", detail.Thread.Channel),
		fmt.Sprintf("Subject: %s", detail.Thread.Subject),
		fmt.Sprintf("Status: %s", detail.Thread.Status),
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
