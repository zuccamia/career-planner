package communications

// Validates communication threads and entries before persistence and LLM usage.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ngochoang/career-planner/internal/sources/llm"
)

var allowedChannels = map[string]struct{}{
	"email":     {},
	"handshake": {},
	"linkedin":  {},
	"call":      {},
	"meeting":   {},
	"text":      {},
	"general":   {},
}

var allowedDirections = map[string]struct{}{
	"inbound":  {},
	"outbound": {},
	"note":     {},
}

var allowedStatuses = map[string]struct{}{
	"open":   {},
	"closed": {},
}

// Count returns the number of persisted communication threads.
func (s *Service) Count(ctx context.Context) (int, error) {
	return s.repo.Count(ctx)
}

// CreateThread sanitizes user input and persists a new communication thread.
func (s *Service) CreateThread(ctx context.Context, input CreateThreadInput) (Thread, error) {
	input.Channel = normalizeChannel(input.Channel)
	input.Subject = strings.TrimSpace(input.Subject)
	if input.OccurredAt.IsZero() {
		input.OccurredAt = time.Now().UTC()
	}
	if input.PersonID <= 0 {
		return Thread{}, ErrThreadNotFound
	}
	if input.Subject == "" {
		return Thread{}, fmt.Errorf("subject is required")
	}
	return s.repo.CreateThread(ctx, input)
}

// UpdateThread sanitizes editable thread fields and persists them.
func (s *Service) UpdateThread(ctx context.Context, input UpdateThreadInput) (Thread, error) {
	if input.ThreadID <= 0 {
		return Thread{}, ErrThreadNotFound
	}
	input.Channel = normalizeChannel(input.Channel)
	input.Subject = strings.TrimSpace(input.Subject)
	if input.Subject == "" {
		return Thread{}, fmt.Errorf("subject is required")
	}
	return s.repo.UpdateThread(ctx, input)
}

// CreateEntry sanitizes user input and appends a communication entry to an existing thread.
func (s *Service) CreateEntry(ctx context.Context, input CreateEntryInput) (Entry, error) {
	if input.ThreadID <= 0 {
		return Entry{}, ErrThreadNotFound
	}
	input.Direction = normalizeDirection(input.Direction)
	input.Content = strings.TrimSpace(input.Content)
	if input.Content == "" {
		return Entry{}, fmt.Errorf("content is required")
	}
	if input.OccurredAt.IsZero() {
		input.OccurredAt = time.Now().UTC()
	}
	return s.repo.CreateEntry(ctx, input)
}

// DeleteEntry removes one communication entry when the identifier is valid.
func (s *Service) DeleteEntry(ctx context.Context, id int64) error {
	if id <= 0 {
		return ErrEntryNotFound
	}
	return s.repo.DeleteEntry(ctx, id)
}

// UpdateThreadStatus changes one thread status when the identifier and status are valid.
func (s *Service) UpdateThreadStatus(ctx context.Context, threadID int64, status string) (Thread, error) {
	if threadID <= 0 {
		return Thread{}, ErrThreadNotFound
	}
	status = normalizeStatus(status)
	if status == "" {
		return Thread{}, ErrInvalidStatus
	}
	return s.repo.UpdateThreadStatus(ctx, threadID, status)
}

// GetThreadByID returns one communication thread when the identifier is valid.
func (s *Service) GetThreadByID(ctx context.Context, id int64) (Thread, error) {
	if id <= 0 {
		return Thread{}, ErrThreadNotFound
	}
	return s.repo.GetThreadByID(ctx, id)
}

// GetThreadDetail returns a thread together with its entries when the identifier is valid.
func (s *Service) GetThreadDetail(ctx context.Context, id int64) (ThreadDetail, error) {
	if id <= 0 {
		return ThreadDetail{}, ErrThreadNotFound
	}
	return s.repo.GetThreadDetail(ctx, id)
}

// ListThreadsByPersonID returns all threads for one person when the identifier is valid.
func (s *Service) ListThreadsByPersonID(ctx context.Context, personID int64) ([]Thread, error) {
	if personID <= 0 {
		return nil, ErrThreadNotFound
	}
	return s.repo.ListThreadsByPersonID(ctx, personID)
}

// SummarizeThread asks the LLM for a concise thread summary and stores the result on the thread.
func (s *Service) SummarizeThread(ctx context.Context, threadID int64) (Thread, error) {
	detail, err := s.GetThreadDetail(ctx, threadID)
	if err != nil {
		return Thread{}, err
	}
	if s.client == nil {
		return Thread{}, fmt.Errorf("llm client is not configured")
	}

	var out struct {
		Summary string `json:"summary"`
	}
	prompt := llm.Prompt{
		System: summarizeSystemPrompt,
		User:   fmt.Sprintf(summarizeUserPrompt, s.buildThreadContext(ctx, detail)),
	}
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return Thread{}, err
	}
	updatedAt := time.Now().UTC()
	return s.repo.UpdateThreadSummary(ctx, UpdateSummaryInput{
		ThreadID:         threadID,
		Summary:          strings.TrimSpace(out.Summary),
		SummaryUpdatedAt: updatedAt,
		LastActivityAt:   detail.Thread.LastActivityAt,
	})
}

// GenerateMessage asks the LLM to draft either outreach or a reply from thread context.
func (s *Service) GenerateMessage(ctx context.Context, input GenerateMessageInput) (string, error) {
	if input.ThreadID <= 0 {
		return "", ErrThreadNotFound
	}
	goal := strings.TrimSpace(strings.ToLower(input.Goal))
	if goal != "outreach" && goal != "reply" {
		return "", ErrInvalidGoal
	}
	detail, err := s.GetThreadDetail(ctx, input.ThreadID)
	if err != nil {
		return "", err
	}
	if s.client == nil {
		return "", fmt.Errorf("llm client is not configured")
	}
	var out struct {
		Message string `json:"message"`
	}
	prompt := llm.Prompt{
		System: generateSystemPrompt,
		User:   fmt.Sprintf(generateUserPrompt, goal, s.buildThreadContext(ctx, detail)),
	}
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.Message), nil
}

func normalizeChannel(channel string) string {
	channel = strings.TrimSpace(strings.ToLower(channel))
	if _, ok := allowedChannels[channel]; !ok {
		return "general"
	}
	return channel
}

func normalizeDirection(direction string) string {
	direction = strings.TrimSpace(strings.ToLower(direction))
	if _, ok := allowedDirections[direction]; !ok {
		return "note"
	}
	return direction
}

func normalizeStatus(status string) string {
	status = strings.TrimSpace(strings.ToLower(status))
	if _, ok := allowedStatuses[status]; !ok {
		return ""
	}
	return status
}

// buildThreadContext formats thread, person-note, summary, and entry data for LLM prompts.
func (s *Service) buildThreadContext(_ context.Context, detail ThreadDetail) string {
	parts := []string{
		fmt.Sprintf("Person: %s", detail.Thread.PersonName),
		fmt.Sprintf("Channel: %s", detail.Thread.Channel),
		fmt.Sprintf("Subject: %s", detail.Thread.Subject),
		fmt.Sprintf("Status: %s", detail.Thread.Status),
		"Entry direction reference: inbound = from the person to me; outbound = from me to the person; note = private internal note.",
		"Entry order: newest first.",
	}
	if strings.TrimSpace(detail.Thread.PersonNotes) != "" {
		parts = append(parts, fmt.Sprintf("Background notes: %s", strings.TrimSpace(detail.Thread.PersonNotes)))
	}
	if strings.TrimSpace(detail.Thread.Summary) != "" {
		parts = append(parts, fmt.Sprintf("Existing summary: %s", detail.Thread.Summary))
	}
	parts = append(parts, "Entries:")
	for _, entry := range detail.Entries {
		parts = append(parts, fmt.Sprintf("- %s | %s | %s | %s", entry.OccurredAt.Format(time.RFC3339), entry.Direction, entryActorLabel(entry.Direction), strings.TrimSpace(entry.Content)))
	}
	return strings.Join(parts, "\n")
}

func entryActorLabel(direction string) string {
	switch normalizeDirection(direction) {
	case "inbound":
		return "from person to me"
	case "outbound":
		return "from me to person"
	default:
		return "private internal note"
	}
}
