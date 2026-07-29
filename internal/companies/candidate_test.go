package companies

import (
	"context"
	"encoding/json"
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

func TestGuessCandidateSanitizesURLs(t *testing.T) {
	svc := NewService(&fakeClient{payload: `{
		"official_name": "  Acme Corp  ",
		"website": "https://acme.example ",
		"blog_url": "ftp://blog.acme.example",
		"ats_url": "not a url",
		"ats_provider": " Greenhouse ",
		"reasoning": "  looks legit  "
	}`})

	got, err := svc.GuessCandidate(context.Background(), "acme", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.OfficialName != "Acme Corp" {
		t.Errorf("OfficialName = %q, want %q", got.OfficialName, "Acme Corp")
	}
	if got.Website != "https://acme.example" {
		t.Errorf("Website = %q, want %q", got.Website, "https://acme.example")
	}
	if got.BlogURL != "" {
		t.Errorf("BlogURL = %q, want empty (ftp rejected)", got.BlogURL)
	}
	if got.ATSURL != "" {
		t.Errorf("ATSURL = %q, want empty (unparseable)", got.ATSURL)
	}
	if got.ATSProvider != "Greenhouse" {
		t.Errorf("ATSProvider = %q, want %q", got.ATSProvider, "Greenhouse")
	}
	if got.Reasoning != "looks legit" {
		t.Errorf("Reasoning = %q, want %q", got.Reasoning, "looks legit")
	}
}

func TestGuessCandidateFallsBackToInputName(t *testing.T) {
	svc := NewService(&fakeClient{payload: `{"official_name": "  "}`})

	got, err := svc.GuessCandidate(context.Background(), "  fallback co  ", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.OfficialName != "fallback co" {
		t.Errorf("OfficialName = %q, want %q", got.OfficialName, "fallback co")
	}
}

func TestGuessCandidateEmptyInputReturnsEmpty(t *testing.T) {
	svc := NewService(&fakeClient{})
	got, err := svc.GuessCandidate(context.Background(), "   ", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.OfficialName != "" {
		t.Errorf("OfficialName = %q, want empty", got.OfficialName)
	}
}

func TestGuessCandidateNoClientReturnsFallback(t *testing.T) {
	svc := NewService(nil)
	got, err := svc.GuessCandidate(context.Background(), "Acme", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.OfficialName != "Acme" {
		t.Errorf("OfficialName = %q, want %q", got.OfficialName, "Acme")
	}
}
