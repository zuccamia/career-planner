package people

import (
	"fmt"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

func sliceToSet(vals []string) map[string]struct{} {
	set := make(map[string]struct{}, len(vals))
	for _, v := range vals {
		set[v] = struct{}{}
	}
	return set
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
