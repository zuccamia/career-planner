package applications

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ngochoang/career-planner/internal/sources/llm"
)

type fakeRepository struct {
	createInput         CreateApplicationInput
	updateInput         UpdateApplicationInput
	updateStatusID      int64
	updateStatusValue   string
	updateRawID         int64
	updateRawValue      string
	updateExtractedID   int64
	updateExtractedJSON string
	getByIDResult       Application
	createEventInput    CreateEventInput
	createEventInputs   []CreateEventInput
	createArtifactInput CreateArtifactInput
	createCalled        bool
	updateCalled        bool
	updateStatusCalled  bool
	updateRawCalled     bool
	updateExtractedCall bool
	eventCalled         bool
	artifactCalled      bool
}

func (f *fakeRepository) Count(ctx context.Context) (int, error) { return 0, nil }
func (f *fakeRepository) CountByStatus(ctx context.Context, status string) (int, error) {
	return 0, nil
}
func (f *fakeRepository) Create(ctx context.Context, input CreateApplicationInput) (Application, error) {
	f.createCalled = true
	f.createInput = input
	return Application{ID: 1, CompanyID: input.CompanyID, PersonID: input.PersonID, RoleTitle: input.RoleTitle, JobPostingURL: input.JobPostingURL, JobDescriptionRaw: input.JobDescriptionRaw, JobDescriptionExtractedJSON: input.JobDescriptionExtractedJSON, Status: input.Status, Notes: input.Notes, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
}
func (f *fakeRepository) CreateArtifact(ctx context.Context, input CreateArtifactInput) (Artifact, error) {
	f.artifactCalled = true
	f.createArtifactInput = input
	return Artifact{Kind: input.Kind}, nil
}
func (f *fakeRepository) CreateEvent(ctx context.Context, input CreateEventInput) (Event, error) {
	f.eventCalled = true
	f.createEventInput = input
	f.createEventInputs = append(f.createEventInputs, input)
	return Event{Type: input.Type}, nil
}
func (f *fakeRepository) Delete(ctx context.Context, id int64) error { return nil }
func (f *fakeRepository) GetByID(ctx context.Context, id int64) (Application, error) {
	if f.getByIDResult.ID != 0 {
		return f.getByIDResult, nil
	}
	return Application{ID: id}, nil
}
func (f *fakeRepository) List(ctx context.Context) ([]Application, error) { return nil, nil }
func (f *fakeRepository) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	return nil, nil
}
func (f *fakeRepository) ListArtifactsByApplicationID(ctx context.Context, applicationID int64) ([]Artifact, error) {
	return nil, nil
}
func (f *fakeRepository) ListEventsByApplicationID(ctx context.Context, applicationID int64) ([]Event, error) {
	return nil, nil
}
func (f *fakeRepository) Update(ctx context.Context, input UpdateApplicationInput) (Application, error) {
	f.updateCalled = true
	f.updateInput = input
	return Application{ID: input.ID, CompanyID: input.CompanyID, PersonID: input.PersonID, RoleTitle: input.RoleTitle, JobPostingURL: input.JobPostingURL, JobDescriptionRaw: input.JobDescriptionRaw, JobDescriptionExtractedJSON: input.JobDescriptionExtractedJSON, Status: input.Status, Notes: input.Notes, UpdatedAt: time.Now().UTC()}, nil
}
func (f *fakeRepository) UpdateStatus(ctx context.Context, applicationID int64, status string) (Application, error) {
	f.updateStatusCalled = true
	f.updateStatusID = applicationID
	f.updateStatusValue = status
	application := f.getByIDResult
	application.ID = applicationID
	application.Status = status
	application.UpdatedAt = time.Now().UTC()
	return application, nil
}
func (f *fakeRepository) UpdateJobDescriptionRaw(ctx context.Context, applicationID int64, raw string) (Application, error) {
	f.updateRawCalled = true
	f.updateRawID = applicationID
	f.updateRawValue = raw
	application := f.getByIDResult
	application.ID = applicationID
	application.JobDescriptionRaw = raw
	return application, nil
}
func (f *fakeRepository) UpdateJobDescriptionExtractedJSON(ctx context.Context, applicationID int64, extractedJSON string) (Application, error) {
	f.updateExtractedCall = true
	f.updateExtractedID = applicationID
	f.updateExtractedJSON = extractedJSON
	return Application{ID: applicationID, JobDescriptionExtractedJSON: extractedJSON}, nil
}

type fakeLLMClient struct {
	generate func(prompt llm.Prompt, out any) error
}

func (f fakeLLMClient) GenerateJSON(ctx context.Context, prompt llm.Prompt, out any) error {
	if f.generate != nil {
		return f.generate(prompt, out)
	}
	return nil
}

func TestServiceCreateSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.Create(context.Background(), CreateApplicationInput{
		CompanyID:                   2,
		PersonID:                    -3,
		RoleTitle:                   "  Software Engineer Intern  ",
		JobPostingURL:               " https://jobs.example.com/roles/123 ",
		JobDescriptionRaw:           "  detailed job description  ",
		JobDescriptionExtractedJSON: "  {\"level\":\"intern\"}  ",
		Status:                      " APPLIED ",
		Notes:                       "  referral pending  ",
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if repo.createInput.PersonID != 0 || repo.createInput.RoleTitle != "Software Engineer Intern" || repo.createInput.JobPostingURL != "https://jobs.example.com/roles/123" || repo.createInput.JobDescriptionRaw != "detailed job description" || repo.createInput.JobDescriptionExtractedJSON != "{\"level\":\"intern\"}" || repo.createInput.Status != "applied" || repo.createInput.Notes != "referral pending" {
		t.Fatalf("unexpected sanitized create input: %+v", repo.createInput)
	}
}

func TestServiceCreateDefaultsStatusAndExtractedJSON(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.Create(context.Background(), CreateApplicationInput{CompanyID: 1, RoleTitle: "Backend Engineer"})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if repo.createInput.Status != "wishlist" || repo.createInput.JobDescriptionExtractedJSON != "{}" {
		t.Fatalf("unexpected defaults: %+v", repo.createInput)
	}
	if len(repo.createEventInputs) != 0 {
		t.Fatalf("expected no events on create, got %d", len(repo.createEventInputs))
	}
}

func TestServiceCreateRejectsMissingCompany(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.Create(context.Background(), CreateApplicationInput{RoleTitle: "Role"})
	if err == nil || err.Error() != "company is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.createCalled {
		t.Fatal("repo should not be called on invalid input")
	}
}

func TestServiceUpdateSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	repo.getByIDResult = Application{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "applied"}
	svc := NewService(repo, nil)
	_, err := svc.Update(context.Background(), UpdateApplicationInput{
		ID:                          10,
		CompanyID:                   4,
		PersonID:                    -1,
		RoleTitle:                   "  Backend Engineer  ",
		JobPostingURL:               " https://jobs.example.com/backend ",
		JobDescriptionRaw:           "  jd  ",
		JobDescriptionExtractedJSON: " ",
		Status:                      " OFFER ",
		Notes:                       "  top choice  ",
	})
	if err != nil {
		t.Fatalf("Update returned error: %v", err)
	}
	if repo.updateInput.PersonID != 0 || repo.updateInput.RoleTitle != "Backend Engineer" || repo.updateInput.Status != "offer" || repo.updateInput.JobDescriptionExtractedJSON != "{}" || repo.updateInput.Notes != "top choice" {
		t.Fatalf("unexpected sanitized update input: %+v", repo.updateInput)
	}
	if len(repo.createEventInputs) != 2 {
		t.Fatalf("expected 2 events, got %d", len(repo.createEventInputs))
	}
}

func TestServiceUpdatePreservesProvidedExtractedJSON(t *testing.T) {
	repo := &fakeRepository{}
	repo.getByIDResult = Application{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "applied", JobDescriptionRaw: "updated raw description", JobDescriptionExtractedJSON: "{\"level\":\"intern\"}"}
	svc := NewService(repo, nil)
	_, err := svc.Update(context.Background(), UpdateApplicationInput{
		ID:                          10,
		CompanyID:                   4,
		RoleTitle:                   "Backend Engineer",
		JobDescriptionRaw:           "updated raw description",
		JobDescriptionExtractedJSON: "  {\"level\":\"intern\"}  ",
		Status:                      "applied",
	})
	if err != nil {
		t.Fatalf("Update returned error: %v", err)
	}
	if repo.updateInput.JobDescriptionExtractedJSON != "{\"level\":\"intern\"}" {
		t.Fatalf("expected extracted JSON to be preserved, got %+v", repo.updateInput.JobDescriptionExtractedJSON)
	}
	if len(repo.createEventInputs) != 0 {
		t.Fatalf("expected no events for unchanged tracked fields, got %+v", repo.createEventInputs)
	}
}

func TestServiceUpdateCreatesStatusChangedEvent(t *testing.T) {
	repo := &fakeRepository{}
	repo.getByIDResult = Application{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "wishlist"}
	svc := NewService(repo, nil)

	_, err := svc.Update(context.Background(), UpdateApplicationInput{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "applied"})
	if err != nil {
		t.Fatalf("Update returned error: %v", err)
	}
	if len(repo.createEventInputs) != 1 {
		t.Fatalf("expected 1 event, got %d", len(repo.createEventInputs))
	}
	event := repo.createEventInputs[0]
	if event.Type != "status_changed" || event.FromStatus != "wishlist" || event.ToStatus != "applied" {
		t.Fatalf("unexpected status event: %+v", event)
	}
}

func TestServiceUpdateCreatesGenericUpdateEvent(t *testing.T) {
	repo := &fakeRepository{}
	repo.getByIDResult = Application{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "applied", Notes: "old"}
	svc := NewService(repo, nil)

	_, err := svc.Update(context.Background(), UpdateApplicationInput{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "applied", Notes: "new"})
	if err != nil {
		t.Fatalf("Update returned error: %v", err)
	}
	if len(repo.createEventInputs) != 1 {
		t.Fatalf("expected 1 event, got %d", len(repo.createEventInputs))
	}
	event := repo.createEventInputs[0]
	if event.Type != "note" || !strings.Contains(event.Content, "notes") {
		t.Fatalf("unexpected generic update event: %+v", event)
	}
}

func TestServiceUpdateRejectsInvalidID(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.Update(context.Background(), UpdateApplicationInput{ID: 0, CompanyID: 1, RoleTitle: "Role", Status: "applied"})
	if !errors.Is(err, ErrApplicationNotFound) {
		t.Fatalf("expected ErrApplicationNotFound, got %v", err)
	}
}

func TestServiceUpdateStatusSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	repo.getByIDResult = Application{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "wishlist"}
	svc := NewService(repo, nil)

	occurredAt := time.Date(2026, time.July, 22, 12, 30, 0, 0, time.UTC)
	_, err := svc.UpdateStatus(context.Background(), UpdateStatusInput{ApplicationID: 10, Status: " OFFER ", OccurredAt: occurredAt, Notes: "  recruiter advanced me  "})
	if err != nil {
		t.Fatalf("UpdateStatus returned error: %v", err)
	}
	if !repo.updateStatusCalled || repo.updateStatusID != 10 || repo.updateStatusValue != "offer" {
		t.Fatalf("unexpected update status call: id=%d status=%q called=%v", repo.updateStatusID, repo.updateStatusValue, repo.updateStatusCalled)
	}
	if len(repo.createEventInputs) != 1 {
		t.Fatalf("expected 1 event, got %d", len(repo.createEventInputs))
	}
	event := repo.createEventInputs[0]
	if event.Content != "recruiter advanced me" || !event.OccurredAt.Equal(occurredAt) {
		t.Fatalf("unexpected update status event: %+v", event)
	}
}

func TestServiceUpdateStatusReturnsExistingApplicationWhenStatusUnchanged(t *testing.T) {
	repo := &fakeRepository{}
	repo.getByIDResult = Application{ID: 10, CompanyID: 4, RoleTitle: "Backend Engineer", Status: "applied"}
	svc := NewService(repo, nil)

	application, err := svc.UpdateStatus(context.Background(), UpdateStatusInput{ApplicationID: 10, Status: " applied "})
	if err != nil {
		t.Fatalf("UpdateStatus returned error: %v", err)
	}
	if repo.updateStatusCalled {
		t.Fatal("expected repo.UpdateStatus not to be called for unchanged status")
	}
	if len(repo.createEventInputs) != 0 {
		t.Fatalf("expected no events, got %d", len(repo.createEventInputs))
	}
	if application.Status != "applied" {
		t.Fatalf("unexpected application returned: %+v", application)
	}
}

func TestServiceCreateEventNormalizesDefaults(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.CreateEvent(context.Background(), CreateEventInput{ApplicationID: 1, Type: " NOTE ", Content: "  recruiter replied  "})
	if err != nil {
		t.Fatalf("CreateEvent returned error: %v", err)
	}
	if repo.createEventInput.Type != "note" || repo.createEventInput.Content != "recruiter replied" || repo.createEventInput.OccurredAt.IsZero() {
		t.Fatalf("unexpected sanitized event input: %+v", repo.createEventInput)
	}
}

func TestServiceCreateEventRejectsMissingStatusForStatusChange(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.CreateEvent(context.Background(), CreateEventInput{ApplicationID: 1, Type: "status_changed"})
	if err == nil || err.Error() != "destination status is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.eventCalled {
		t.Fatal("repo should not be called on invalid input")
	}
}

func TestServiceCreateArtifactValidatesStorage(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.CreateArtifact(context.Background(), CreateArtifactInput{ApplicationID: 1, Kind: "resume_tailored", StorageType: "file"})
	if err == nil || err.Error() != "artifact file path is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.artifactCalled {
		t.Fatal("repo should not be called on invalid input")
	}
}

func TestServiceCreateArtifactSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.CreateArtifact(context.Background(), CreateArtifactInput{
		ApplicationID: 1,
		Kind:          "  resume_tailored  ",
		Label:         "  Resume v1  ",
		StorageType:   " FILE ",
		FilePath:      "  data/resumes/applications/1/resume_v1.tex  ",
		MimeType:      "  text/x-tex  ",
	})
	if err != nil {
		t.Fatalf("CreateArtifact returned error: %v", err)
	}
	if repo.createArtifactInput.Kind != "resume_tailored" || repo.createArtifactInput.Label != "Resume v1" || repo.createArtifactInput.StorageType != "file" || repo.createArtifactInput.FilePath != "data/resumes/applications/1/resume_v1.tex" || repo.createArtifactInput.MimeType != "text/x-tex" {
		t.Fatalf("unexpected sanitized artifact input: %+v", repo.createArtifactInput)
	}
}

func TestExtractJobDescriptionRejectsMissingLLM(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.ExtractJobDescription(context.Background(), 1)
	if err == nil || err.Error() != "llm client is not configured" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExtractJobDescriptionRejectsMissingRawDescription(t *testing.T) {
	repo := &fakeRepository{getByIDResult: Application{ID: 1, RoleTitle: "SWE", CompanyName: "Google"}}
	svc := NewService(repo, fakeLLMClient{})
	_, err := svc.ExtractJobDescription(context.Background(), 1)
	if err == nil || err.Error() != "job description raw or posting URL is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.updateExtractedCall {
		t.Fatal("expected extracted JSON update not to be called")
	}
}

func TestExtractJobDescriptionFetchesAndPersistsRawFromURL(t *testing.T) {
	repo := &fakeRepository{getByIDResult: Application{
		ID:            7,
		CompanyName:   "Google",
		RoleTitle:     "Software Engineer",
		JobPostingURL: "https://careers.example.com/job/7",
	}}
	svc := NewService(repo, fakeLLMClient{generate: func(prompt llm.Prompt, out any) error {
		result := out.(*JobDescriptionStructured)
		result.Summary = "Fetched description"
		return nil
	}})
	svc.fetchURL = func(ctx context.Context, url string) (string, error) {
		if url != "https://careers.example.com/job/7" {
			t.Fatalf("unexpected URL: %s", url)
		}
		return "  Job fetched from URL body.  ", nil
	}

	application, err := svc.ExtractJobDescription(context.Background(), 7)
	if err != nil {
		t.Fatalf("ExtractJobDescription returned error: %v", err)
	}
	if !repo.updateRawCalled || repo.updateRawID != 7 {
		t.Fatalf("expected raw update for application 7, got %+v", repo)
	}
	if repo.updateRawValue != "  Job fetched from URL body.  " {
		t.Fatalf("unexpected raw value persisted: %q", repo.updateRawValue)
	}
	if !repo.updateExtractedCall {
		t.Fatal("expected extracted JSON update to be called")
	}
	if application.JobDescriptionExtractedJSON == "" {
		t.Fatal("expected returned application to include extracted JSON")
	}
}

func TestExtractJobDescriptionOverwritesExtractedJSON(t *testing.T) {
	repo := &fakeRepository{getByIDResult: Application{
		ID:                42,
		CompanyName:       "Google",
		RoleTitle:         "Software Engineering Intern",
		JobPostingURL:     "https://careers.example.com/job/42",
			JobDescriptionRaw: "Master's internship in distributed systems using Go and Python. This is a full-time internship role.",
	}}
	svc := NewService(repo, fakeLLMClient{generate: func(prompt llm.Prompt, out any) error {
		result := out.(*JobDescriptionStructured)
		result.CompanyName = "  "
		result.RoleTitle = "  "
		result.RoleLevel = "Internship"
		result.EmploymentType = "Internship"
		result.Season = "Summer"
		result.Year = 2027
		result.Salary.Currency = " usd "
		result.Salary.Amount = " 98,000-131,000 "
		result.Locations = []string{" Mountain View, CA ", "mountain view, ca", "Atlanta, GA"}
		result.MinimumQualifications = []string{" Data structures ", "data structures", "Algorithms"}
		result.Requirements.Majors = []string{" Computer Science ", "computer science", "Computer Engineering"}
		result.Requirements.TranscriptRequired = true
		result.Summary = " 12-week internship building distributed systems. "
		return nil
	}})

	application, err := svc.ExtractJobDescription(context.Background(), 42)
	if err != nil {
		t.Fatalf("ExtractJobDescription returned error: %v", err)
	}
	if !repo.updateExtractedCall || repo.updateExtractedID != 42 {
		t.Fatalf("expected extracted JSON update for application 42, got %+v", repo)
	}
	var structured JobDescriptionStructured
	if err := json.Unmarshal([]byte(repo.updateExtractedJSON), &structured); err != nil {
		t.Fatalf("unmarshal extracted JSON: %v", err)
	}
	if structured.SchemaVersion != "job_description.v1" {
		t.Fatalf("expected schema version, got %q", structured.SchemaVersion)
	}
	if structured.CompanyName != "Google" || structured.RoleTitle != "Software Engineering Intern" {
		t.Fatalf("expected fallback company/role, got %+v", structured)
	}
	if structured.RoleLevel != "intern" || structured.EmploymentType != "full_time" || structured.Season != "summer" || structured.Year != 2027 {
		t.Fatalf("unexpected normalized overview fields: %+v", structured)
	}
	if structured.Salary.Currency != "USD" || structured.Salary.Amount != "98,000-131,000" {
		t.Fatalf("unexpected normalized salary: %+v", structured.Salary)
	}
	if len(structured.Locations) != 2 {
		t.Fatalf("expected deduplicated locations, got %+v", structured.Locations)
	}
	if len(structured.MinimumQualifications) != 2 {
		t.Fatalf("expected deduplicated qualifications, got %+v", structured.MinimumQualifications)
	}
	if len(structured.Requirements.Majors) != 2 {
		t.Fatalf("expected deduplicated majors, got %+v", structured.Requirements.Majors)
	}
	if structured.Summary != "12-week internship building distributed systems." {
		t.Fatalf("unexpected summary: %q", structured.Summary)
	}
	if application.JobDescriptionExtractedJSON == "" {
		t.Fatal("expected returned application to include extracted JSON")
	}
}

func TestHTMLToTextRemovesBoilerplateAndPreservesStructure(t *testing.T) {
	html := `<html><body>
	<nav>Home Jobs Companies</nav>
	<div class="cookie-banner">We use cookies</div>
	<main>
	  <h1>Software Engineer Intern</h1>
	  <p>Build distributed systems.</p>
	  <ul><li>Go</li><li>Python</li></ul>
	  <p>Apply by&nbsp;October 1</p>
	</main>
	<footer>Privacy terms</footer>
	</body></html>`

	got := htmlToText(html)
	if strings.Contains(got, "We use cookies") || strings.Contains(got, "Privacy terms") || strings.Contains(got, "Home Jobs Companies") {
		t.Fatalf("expected boilerplate to be removed, got %q", got)
	}
	for _, want := range []string{"Software Engineer Intern", "Build distributed systems.", "- Go", "- Python", "Apply by October 1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in cleaned text, got %q", want, got)
		}
	}
}

func TestLoginRedirectURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{url: "https://app.joinhandshake.com/access", want: true},
		{url: "https://example.com/login", want: true},
		{url: "https://example.com/sign-in", want: true},
		{url: "https://example.com/jobs/123", want: false},
	}
	for _, tt := range tests {
		if got := loginRedirectURL(tt.url); got != tt.want {
			t.Fatalf("loginRedirectURL(%q) = %v, want %v", tt.url, got, tt.want)
		}
	}
}

func TestExtractStructuredJobPostingTextFromLDJSON(t *testing.T) {
	html := `<html><head>
	<script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","title":"Software Engineer Intern","description":"<p>Build backend systems.</p><p>Requirements</p><p>Go<br>Python</p>"}</script>
	</head><body><div>fallback</div></body></html>`

	got := extractStructuredJobPostingText(html)
	for _, want := range []string{"Build backend systems.", "Requirements", "Go", "Python"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in extracted text, got %q", want, got)
		}
	}
}
