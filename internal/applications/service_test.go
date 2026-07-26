package applications

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

type fakeClient struct {
	payload string
	err     error
}

func (f *fakeClient) GenerateJSON(_ context.Context, _ llm.Prompt, out any) error {
	if f.err != nil {
		return f.err
	}
	return json.Unmarshal([]byte(f.payload), out)
}

func TestExtractJobDescriptionTextRequiresClient(t *testing.T) {
	svc := &Service{}
	_, _, err := svc.ExtractJobDescriptionText(context.Background(), ExtractJobDescriptionTextInput{
		JobDescriptionRaw: "hello",
	})
	if err == nil {
		t.Fatal("expected error when llm client is nil")
	}
}

func TestExtractJobDescriptionTextRequiresRawOrURL(t *testing.T) {
	svc := &Service{client: &fakeClient{payload: `{}`}}
	_, _, err := svc.ExtractJobDescriptionText(context.Background(), ExtractJobDescriptionTextInput{})
	if err == nil {
		t.Fatal("expected error when both raw and URL are empty")
	}
}

func TestExtractJobDescriptionTextFetchesWhenRawEmpty(t *testing.T) {
	fetched := "Fetched JD body about Go engineering."
	svc := &Service{
		client:  &fakeClient{payload: `{"role_title":"Engineer"}`},
		fetchURL: func(_ context.Context, url string) (string, error) {
			if url != "https://acme.example/jobs/1" {
				t.Errorf("unexpected fetch url: %q", url)
			}
			return fetched, nil
		},
	}
	_, raw, err := svc.ExtractJobDescriptionText(context.Background(), ExtractJobDescriptionTextInput{
		CompanyName:   "Acme",
		RoleTitle:     "Engineer",
		JobPostingURL: "https://acme.example/jobs/1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw != fetched {
		t.Errorf("raw = %q, want %q", raw, fetched)
	}
}

func TestExtractJobDescriptionTextPropagatesFetchError(t *testing.T) {
	boom := errors.New("network down")
	svc := &Service{
		client:   &fakeClient{payload: `{}`},
		fetchURL: func(_ context.Context, _ string) (string, error) { return "", boom },
	}
	_, _, err := svc.ExtractJobDescriptionText(context.Background(), ExtractJobDescriptionTextInput{
		JobPostingURL: "https://acme.example/jobs/1",
	})
	if err == nil || !errors.Is(err, boom) {
		t.Fatalf("expected wrapped fetch error, got %v", err)
	}
}

func TestExtractJobDescriptionTextRequiresFetcherWhenRawEmpty(t *testing.T) {
	svc := &Service{client: &fakeClient{payload: `{}`}}
	_, _, err := svc.ExtractJobDescriptionText(context.Background(), ExtractJobDescriptionTextInput{
		JobPostingURL: "https://acme.example/jobs/1",
	})
	if err == nil {
		t.Fatal("expected error when fetcher is nil and raw is empty")
	}
}

func TestExtractJobDescriptionTextPropagatesClientError(t *testing.T) {
	boom := errors.New("llm failed")
	svc := &Service{client: &fakeClient{err: boom}}
	_, _, err := svc.ExtractJobDescriptionText(context.Background(), ExtractJobDescriptionTextInput{
		JobDescriptionRaw: "raw",
	})
	if err == nil || !errors.Is(err, boom) {
		t.Fatalf("expected wrapped llm error, got %v", err)
	}
}

func TestExtractJobDescriptionTextReturnsSanitizedStructuredOutput(t *testing.T) {
	svc := &Service{client: &fakeClient{payload: `{
		"role_title": "Engineer",
		"role_level": "Fresh graduate",
		"requirements": {"education": "Bachelor of Science in Computer Science"}
	}`}}
	got, raw, err := svc.ExtractJobDescriptionText(context.Background(), ExtractJobDescriptionTextInput{
		CompanyName:       "Acme",
		RoleTitle:         "Engineer",
		JobDescriptionRaw: "  raw body  ",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw != "raw body" {
		t.Errorf("raw = %q, want trimmed", raw)
	}
	if got.RoleLevel != "new_grad" {
		t.Errorf("RoleLevel = %q, want new_grad (sanitized)", got.RoleLevel)
	}
	if len(got.Requirements.Education) != 1 || got.Requirements.Education[0] != "Bachelor's degree" {
		t.Errorf("Requirements.Education = %#v, want normalized", got.Requirements.Education)
	}
}
