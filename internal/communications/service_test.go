package communications

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ngochoang/career-planner/internal/sources/llm"
)

type fakeRepository struct {
	createThreadInput  CreateThreadInput
	createEntryInput   CreateEntryInput
	threadDetail       ThreadDetail
	updateSummaryInput UpdateSummaryInput
	updateStatusThread int64
	updateStatusValue  string
}

func (f *fakeRepository) Count(ctx context.Context) (int, error) { return 0, nil }
func (f *fakeRepository) CreateThread(ctx context.Context, input CreateThreadInput) (Thread, error) {
	f.createThreadInput = input
	return Thread{PersonID: input.PersonID, Channel: input.Channel, Subject: input.Subject}, nil
}
func (f *fakeRepository) CreateEntry(ctx context.Context, input CreateEntryInput) (Entry, error) {
	f.createEntryInput = input
	return Entry{ThreadID: input.ThreadID, Direction: input.Direction, Content: input.Content, OccurredAt: input.OccurredAt}, nil
}
func (f *fakeRepository) DeleteEntry(ctx context.Context, id int64) error { return nil }
func (f *fakeRepository) GetThreadByID(ctx context.Context, id int64) (Thread, error) {
	return Thread{ID: id}, nil
}
func (f *fakeRepository) GetThreadDetail(ctx context.Context, id int64) (ThreadDetail, error) {
	return f.threadDetail, nil
}
func (f *fakeRepository) ListThreadsByPersonID(ctx context.Context, personID int64) ([]Thread, error) {
	return nil, nil
}
func (f *fakeRepository) UpdateThreadStatus(ctx context.Context, threadID int64, status string) (Thread, error) {
	f.updateStatusThread = threadID
	f.updateStatusValue = status
	return Thread{ID: threadID, Status: status}, nil
}
func (f *fakeRepository) UpdateThreadSummary(ctx context.Context, input UpdateSummaryInput) (Thread, error) {
	f.updateSummaryInput = input
	return Thread{ID: input.ThreadID, Summary: input.Summary}, nil
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

func TestCreateThreadNormalizesChannelAndDefaultsOccurredAt(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.CreateThread(context.Background(), CreateThreadInput{PersonID: 1, Channel: "unknown", Subject: "  Intro  "})
	if err != nil {
		t.Fatalf("CreateThread returned error: %v", err)
	}
	if repo.createThreadInput.Channel != "general" {
		t.Fatalf("expected channel to normalize to general, got %q", repo.createThreadInput.Channel)
	}
	if repo.createThreadInput.Subject != "Intro" {
		t.Fatalf("expected trimmed subject, got %q", repo.createThreadInput.Subject)
	}
	if repo.createThreadInput.OccurredAt.IsZero() {
		t.Fatal("expected OccurredAt to be defaulted")
	}
}

func TestCreateThreadRejectsInvalidPersonID(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.CreateThread(context.Background(), CreateThreadInput{PersonID: 0, Subject: "Hello"})
	if !errors.Is(err, ErrThreadNotFound) {
		t.Fatalf("expected ErrThreadNotFound, got %v", err)
	}
}

func TestCreateThreadRejectsEmptySubject(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.CreateThread(context.Background(), CreateThreadInput{PersonID: 1, Subject: "   "})
	if err == nil || err.Error() != "subject is required" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCreateEntryNormalizesDirectionAndDefaultsOccurredAt(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo, nil)
	_, err := svc.CreateEntry(context.Background(), CreateEntryInput{ThreadID: 1, Direction: "weird", Content: "  note content  "})
	if err != nil {
		t.Fatalf("CreateEntry returned error: %v", err)
	}
	if repo.createEntryInput.Direction != "note" {
		t.Fatalf("expected direction to normalize to note, got %q", repo.createEntryInput.Direction)
	}
	if repo.createEntryInput.Content != "note content" {
		t.Fatalf("expected trimmed content, got %q", repo.createEntryInput.Content)
	}
	if repo.createEntryInput.OccurredAt.IsZero() {
		t.Fatal("expected OccurredAt to be defaulted")
	}
}

func TestCreateEntryRejectsInvalidThreadID(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.CreateEntry(context.Background(), CreateEntryInput{ThreadID: 0, Content: "Hello"})
	if !errors.Is(err, ErrThreadNotFound) {
		t.Fatalf("expected ErrThreadNotFound, got %v", err)
	}
}

func TestCreateEntryRejectsEmptyContent(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.CreateEntry(context.Background(), CreateEntryInput{ThreadID: 1, Content: "   "})
	if err == nil || err.Error() != "content is required" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestUpdateThreadStatusRejectsInvalidStatus(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.UpdateThreadStatus(context.Background(), 1, "pending")
	if !errors.Is(err, ErrInvalidStatus) {
		t.Fatalf("expected ErrInvalidStatus, got %v", err)
	}
}

func TestGenerateMessageRejectsInvalidGoal(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	_, err := svc.GenerateMessage(context.Background(), GenerateMessageInput{ThreadID: 1, Goal: "draft"})
	if !errors.Is(err, ErrInvalidGoal) {
		t.Fatalf("expected ErrInvalidGoal, got %v", err)
	}
}

func TestGenerateMessageRequiresLLMClient(t *testing.T) {
	repo := &fakeRepository{threadDetail: ThreadDetail{Thread: Thread{ID: 1}}}
	svc := NewService(repo, nil)
	_, err := svc.GenerateMessage(context.Background(), GenerateMessageInput{ThreadID: 1, Goal: "reply"})
	if err == nil || err.Error() != "llm client is not configured" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSummarizeThreadRequiresLLMClient(t *testing.T) {
	repo := &fakeRepository{threadDetail: ThreadDetail{Thread: Thread{ID: 1, LastActivityAt: time.Now().UTC()}}}
	svc := NewService(repo, nil)
	_, err := svc.SummarizeThread(context.Background(), 1)
	if err == nil || err.Error() != "llm client is not configured" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBuildThreadContextIncludesOptionalFields(t *testing.T) {
	svc := NewService(&fakeRepository{}, nil)
	contextText := svc.buildThreadContext(context.Background(), ThreadDetail{
		Thread: Thread{
			PersonName:     "Jane Doe",
			PersonNotes:    "Strong referral",
			Channel:        "email",
			Subject:        "Follow up",
			Status:         "open",
			Summary:        "Waiting on reply",
			LastActivityAt: time.Now().UTC(),
		},
		Entries: []Entry{{OccurredAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), Direction: "outbound", Content: "Sent first email"}},
	})

	for _, want := range []string{"Person: Jane Doe", "Background notes: Strong referral", "Existing summary: Waiting on reply", "- 2026-01-02T03:04:05Z | outbound | Sent first email"} {
		if !strings.Contains(contextText, want) {
			t.Fatalf("expected context to contain %q, got %q", want, contextText)
		}
	}
}
