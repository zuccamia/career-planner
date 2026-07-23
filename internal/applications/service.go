package applications

// Validates and normalizes application data before persistence.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ngochoang/career-planner/internal/shared"
	"github.com/ngochoang/career-planner/internal/sources/llm"
)

var allowedStatuses = makeAllowedValues(Statuses)

var allowedEventTypes = map[string]struct{}{
	"created":        {},
	"status_changed": {},
	"note":           {},
	"artifact_added": {},
}

var allowedArtifactStorageTypes = map[string]struct{}{
	"inline": {},
	"file":   {},
}

// Count returns the number of persisted applications.
func (s *Service) Count(ctx context.Context) (int, error) {
	return s.repo.Count(ctx)
}

// CountByStatus returns the number of persisted applications in one status.
func (s *Service) CountByStatus(ctx context.Context, status string) (int, error) {
	status = normalizeStatus(status)
	if status == "" {
		return 0, errors.New("application status is required")
	}
	return s.repo.CountByStatus(ctx, status)
}

// Create sanitizes user input and persists a new application.
func (s *Service) Create(ctx context.Context, input CreateApplicationInput) (Application, error) {
	input.CompanyID, input.PersonID, input.RoleTitle, input.JobPostingURL, input.JobDescriptionRaw, input.JobDescriptionExtractedJSON, input.Status, input.Notes = normalizeApplicationFields(
		input.CompanyID,
		input.PersonID,
		input.RoleTitle,
		input.JobPostingURL,
		input.JobDescriptionRaw,
		input.JobDescriptionExtractedJSON,
		input.Status,
		input.Notes,
	)

	if input.CompanyID <= 0 {
		return Application{}, errors.New("company is required")
	}
	if input.RoleTitle == "" {
		return Application{}, errors.New("role title is required")
	}

	application, err := s.repo.Create(ctx, input)
	if err != nil {
		return Application{}, err
	}

	return application, nil
}

// GetByID returns one application when the identifier is valid.
func (s *Service) GetByID(ctx context.Context, id int64) (Application, error) {
	if id <= 0 {
		return Application{}, ErrApplicationNotFound
	}
	return s.repo.GetByID(ctx, id)
}

// List returns all applications from storage.
func (s *Service) List(ctx context.Context) ([]Application, error) {
	return s.repo.List(ctx)
}

// ListCompanyCounts returns each company with its linked application total.
func (s *Service) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	return s.repo.ListCompanyCounts(ctx)
}

// Update sanitizes user input and persists changes to an existing application.
func (s *Service) Update(ctx context.Context, input UpdateApplicationInput) (Application, error) {
	input.ID = shared.NonNegativeInt64(input.ID)
	input.CompanyID, input.PersonID, input.RoleTitle, input.JobPostingURL, input.JobDescriptionRaw, input.JobDescriptionExtractedJSON, input.Status, input.Notes = normalizeApplicationFields(
		input.CompanyID,
		input.PersonID,
		input.RoleTitle,
		input.JobPostingURL,
		input.JobDescriptionRaw,
		input.JobDescriptionExtractedJSON,
		input.Status,
		input.Notes,
	)

	if input.ID <= 0 {
		return Application{}, ErrApplicationNotFound
	}
	if input.CompanyID <= 0 {
		return Application{}, errors.New("company is required")
	}
	if input.RoleTitle == "" {
		return Application{}, errors.New("role title is required")
	}
	if input.Status == "" {
		return Application{}, errors.New("application status is required")
	}

	before, err := s.repo.GetByID(ctx, input.ID)
	if err != nil {
		return Application{}, err
	}

	application, err := s.repo.Update(ctx, input)
	if err != nil {
		return Application{}, err
	}

	if before.Status != application.Status {
		if _, err := s.repo.CreateEvent(ctx, CreateEventInput{
			ApplicationID: application.ID,
			Type:          "status_changed",
			FromStatus:    before.Status,
			ToStatus:      application.Status,
			OccurredAt:    application.UpdatedAt,
		}); err != nil {
			return Application{}, err
		}
	}

	if summary := summarizeApplicationChanges(before, application); summary != "" {
		if _, err := s.repo.CreateEvent(ctx, CreateEventInput{
			ApplicationID: application.ID,
			Type:          "note",
			Content:       summary,
			OccurredAt:    application.UpdatedAt,
		}); err != nil {
			return Application{}, err
		}
	}

	return application, nil
}

// UpdateStatus changes only the application status and records a timeline event when it changes.
func (s *Service) UpdateStatus(ctx context.Context, input UpdateStatusInput) (Application, error) {
	input.ApplicationID = shared.NonNegativeInt64(input.ApplicationID)
	input.Status = normalizeStatus(input.Status)
	input.Notes = strings.TrimSpace(input.Notes)

	if input.ApplicationID <= 0 {
		return Application{}, ErrApplicationNotFound
	}
	if input.Status == "" {
		return Application{}, errors.New("application status is required")
	}
	if input.OccurredAt.IsZero() {
		input.OccurredAt = time.Now().UTC()
	}

	before, err := s.repo.GetByID(ctx, input.ApplicationID)
	if err != nil {
		return Application{}, err
	}
	if before.Status == input.Status {
		return before, nil
	}

	application, err := s.repo.UpdateStatus(ctx, input.ApplicationID, input.Status)
	if err != nil {
		return Application{}, err
	}

	if _, err := s.repo.CreateEvent(ctx, CreateEventInput{
		ApplicationID: application.ID,
		Type:          "status_changed",
		Content:       input.Notes,
		FromStatus:    before.Status,
		ToStatus:      application.Status,
		OccurredAt:    input.OccurredAt,
	}); err != nil {
		return Application{}, err
	}

	return application, nil
}

// ExtractJobDescription asks the configured LLM to turn raw job description text into structured JSON.
func (s *Service) ExtractJobDescription(ctx context.Context, applicationID int64) (Application, error) {
	if applicationID <= 0 {
		return Application{}, ErrApplicationNotFound
	}
	if s.client == nil {
		return Application{}, fmt.Errorf("llm client is not configured")
	}
	application, err := s.repo.GetByID(ctx, applicationID)
	if err != nil {
		return Application{}, err
	}
	if strings.TrimSpace(application.JobDescriptionRaw) == "" {
		if strings.TrimSpace(application.JobPostingURL) == "" {
			return Application{}, errors.New("job description raw or posting URL is required")
		}
		if s.fetchURL == nil {
			return Application{}, errors.New("job posting fetcher is not configured")
		}
		fetchedRaw, err := s.fetchURL(ctx, application.JobPostingURL)
		if err != nil {
			return Application{}, fmt.Errorf("fetch job description from URL: %w", err)
		}
		application, err = s.repo.UpdateJobDescriptionRaw(ctx, applicationID, fetchedRaw)
		if err != nil {
			return Application{}, err
		}
	}

	var out JobDescriptionStructured
	prompt := llm.Prompt{
		System: extractJobDescriptionSystemPrompt,
		User: fmt.Sprintf(
			extractJobDescriptionUserPrompt,
			application.CompanyName,
			application.RoleTitle,
			application.JobPostingURL,
			application.JobDescriptionRaw,
		),
	}
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return Application{}, err
	}
	out = sanitizeJobDescriptionStructured(out, application)
	payload, err := json.Marshal(out)
	if err != nil {
		return Application{}, fmt.Errorf("marshal extracted job description: %w", err)
	}
	return s.repo.UpdateJobDescriptionExtractedJSON(ctx, applicationID, string(payload))
}

// Delete removes an application when the identifier is valid.
func (s *Service) Delete(ctx context.Context, id int64) error {
	if id <= 0 {
		return ErrApplicationNotFound
	}
	return s.repo.Delete(ctx, id)
}

// ListEventsByApplicationID returns application timeline entries when the identifier is valid.
func (s *Service) ListEventsByApplicationID(ctx context.Context, applicationID int64) ([]Event, error) {
	if applicationID <= 0 {
		return nil, ErrApplicationNotFound
	}
	return s.repo.ListEventsByApplicationID(ctx, applicationID)
}

// CreateEvent sanitizes user input and appends an application event.
func (s *Service) CreateEvent(ctx context.Context, input CreateEventInput) (Event, error) {
	if input.ApplicationID <= 0 {
		return Event{}, ErrApplicationNotFound
	}
	input.Type = normalizeEventType(input.Type)
	if input.Type == "" {
		input.Type = "note"
	}
	input.Content = strings.TrimSpace(input.Content)
	input.FromStatus = normalizeStatus(input.FromStatus)
	input.ToStatus = normalizeStatus(input.ToStatus)
	if input.OccurredAt.IsZero() {
		input.OccurredAt = time.Now().UTC()
	}

	if input.Type == "note" && input.Content == "" {
		return Event{}, errors.New("event content is required")
	}
	if input.Type == "status_changed" && input.ToStatus == "" {
		return Event{}, errors.New("destination status is required")
	}

	return s.repo.CreateEvent(ctx, input)
}

// ListArtifactsByApplicationID returns application artifacts when the identifier is valid.
func (s *Service) ListArtifactsByApplicationID(ctx context.Context, applicationID int64) ([]Artifact, error) {
	if applicationID <= 0 {
		return nil, ErrApplicationNotFound
	}
	return s.repo.ListArtifactsByApplicationID(ctx, applicationID)
}

// CreateArtifact sanitizes user input and persists one application artifact.
func (s *Service) CreateArtifact(ctx context.Context, input CreateArtifactInput) (Artifact, error) {
	if input.ApplicationID <= 0 {
		return Artifact{}, ErrApplicationNotFound
	}
	input.Kind = strings.TrimSpace(input.Kind)
	input.Label = strings.TrimSpace(input.Label)
	input.StorageType = normalizeArtifactStorageType(input.StorageType)
	if input.StorageType == "" {
		input.StorageType = "inline"
	}
	input.FilePath = strings.TrimSpace(input.FilePath)
	input.Content = strings.TrimSpace(input.Content)
	input.MimeType = strings.TrimSpace(input.MimeType)
	if input.MimeType == "" {
		input.MimeType = "text/plain"
	}

	if input.Kind == "" {
		return Artifact{}, errors.New("artifact kind is required")
	}
	if input.StorageType == "file" && input.FilePath == "" {
		return Artifact{}, errors.New("artifact file path is required")
	}
	if input.StorageType == "inline" && input.Content == "" {
		return Artifact{}, errors.New("artifact content is required")
	}

	return s.repo.CreateArtifact(ctx, input)
}

func normalizeStatus(status string) string {
	status = strings.TrimSpace(strings.ToLower(status))
	if _, ok := allowedStatuses[status]; !ok {
		return ""
	}
	return status
}

func normalizeEventType(eventType string) string {
	eventType = strings.TrimSpace(strings.ToLower(eventType))
	if _, ok := allowedEventTypes[eventType]; !ok {
		return ""
	}
	return eventType
}

func normalizeArtifactStorageType(storageType string) string {
	storageType = strings.TrimSpace(strings.ToLower(storageType))
	if _, ok := allowedArtifactStorageTypes[storageType]; !ok {
		return ""
	}
	return storageType
}

func normalizeApplicationFields(companyID, personID int64, roleTitle, jobPostingURL, jobDescriptionRaw, jobDescriptionExtractedJSON, status, notes string) (int64, int64, string, string, string, string, string, string) {
	return shared.NonNegativeInt64(companyID),
		shared.NonNegativeInt64(personID),
		strings.TrimSpace(roleTitle),
		shared.SanitizeHTTPURL(jobPostingURL),
		strings.TrimSpace(jobDescriptionRaw),
		normalizeExtractedJSON(jobDescriptionExtractedJSON),
		normalizeInputStatus(status),
		strings.TrimSpace(notes)
}

func normalizeExtractedJSON(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "{}"
	}
	return value
}

func normalizeInputStatus(status string) string {
	status = normalizeStatus(status)
	if status == "" {
		return "wishlist"
	}
	return status
}

func makeAllowedValues(values []string) map[string]struct{} {
	allowed := make(map[string]struct{}, len(values))
	for _, value := range values {
		allowed[value] = struct{}{}
	}
	return allowed
}

func summarizeApplicationChanges(before, after Application) string {
	changes := make([]string, 0, 6)

	if before.CompanyID != after.CompanyID || before.CompanyName != after.CompanyName {
		changes = append(changes, "company")
	}
	if before.PersonID != after.PersonID || before.PersonName != after.PersonName {
		changes = append(changes, "contact")
	}
	if before.RoleTitle != after.RoleTitle {
		changes = append(changes, "role title")
	}
	if before.JobPostingURL != after.JobPostingURL {
		changes = append(changes, "job posting URL")
	}
	if before.Notes != after.Notes {
		changes = append(changes, "notes")
	}

	if len(changes) == 0 {
		return ""
	}

	return "Updated " + strings.Join(changes, ", ")
}


