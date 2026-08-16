package dossiers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

type fakeClient struct {
	payload    string
	err        error
	lastPrompt llm.Prompt
}

func (f *fakeClient) GenerateJSON(_ context.Context, p llm.Prompt, out any) error {
	f.lastPrompt = p
	if f.err != nil {
		return f.err
	}
	if f.payload == "" {
		f.payload = "{}"
	}
	return json.Unmarshal([]byte(f.payload), out)
}

func TestBuildTextSanitizesAndReturnsDossier(t *testing.T) {
	svc := &Service{client: &fakeClient{payload: `{
		"careers_url": "https://acme.example/careers",
		"company_summary": "  Acme   makes    stuff  ",
		"what_the_company_does": "widgets",
		"target_customers": ["SMB", "SMB", "  Enterprise  ", ""],
		"product_areas": ["Widgets"],
		"business_model_clues": [],
		"recent_product_launches": ["2024-05 | Widget X", "2025-01 | Widget Y"],
		"company_culture_notes": ["remote"],
		"has_internships": true,
		"internship_seasons": ["summer"],
		"internship_summary": "  paid  ",
		"major_tech_stacks": {"languages": ["Go", "Go"]},
		"reasoning": "  ok  "
	}`}}

	got, err := svc.Build(context.Background(), companies.Company{OfficialName: "Acme"}, "", Pages{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != "completed" {
		t.Errorf("Status = %q, want %q", got.Status, "completed")
	}
	if got.CareersURL != "https://acme.example/careers" {
		t.Errorf("CareersURL = %q", got.CareersURL)
	}
	if got.CompanySummary != "Acme makes stuff" {
		t.Errorf("CompanySummary = %q, want whitespace collapsed", got.CompanySummary)
	}
	if len(got.TargetCustomers) != 2 || got.TargetCustomers[0] != "SMB" || got.TargetCustomers[1] != "Enterprise" {
		t.Errorf("TargetCustomers = %v, want dedup + trim", got.TargetCustomers)
	}
	if got.RecentProductLaunches[0] != "2025-01 | Widget Y" {
		t.Errorf("RecentProductLaunches not sorted newest-first: %v", got.RecentProductLaunches)
	}
	if len(got.MajorTechStacks.Languages) != 1 || got.MajorTechStacks.Languages[0] != "Go" {
		t.Errorf("MajorTechStacks.Languages = %v, want dedup", got.MajorTechStacks.Languages)
	}
	if got.Reasoning != "ok" {
		t.Errorf("Reasoning = %q, want trimmed", got.Reasoning)
	}
}

func TestBuildTextDropsUnparseableCareersURL(t *testing.T) {
	svc := &Service{client: &fakeClient{payload: `{"careers_url": "not a url"}`}}
	got, err := svc.Build(context.Background(), companies.Company{OfficialName: "Acme"}, "", Pages{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.CareersURL != "" {
		t.Errorf("CareersURL = %q, want empty (unparseable input)", got.CareersURL)
	}
}

func TestBuildTextErrorsWithoutClient(t *testing.T) {
	svc := &Service{}
	_, err := svc.Build(context.Background(), companies.Company{OfficialName: "Acme"}, "", Pages{})
	if err == nil {
		t.Fatal("expected error when llm client is nil")
	}
}

func TestBuildTextPropagatesClientError(t *testing.T) {
	boom := errors.New("boom")
	svc := &Service{client: &fakeClient{err: boom}}
	_, err := svc.Build(context.Background(), companies.Company{OfficialName: "Acme"}, "", Pages{})
	if err == nil || !errors.Is(err, boom) {
		t.Fatalf("expected wrapped boom, got %v", err)
	}
}

func TestBuildDossierPromptEmbedsWebsiteContent(t *testing.T) {
	client := &fakeClient{payload: "{}"}
	svc := &Service{client: client}
	if _, err := svc.Build(
		context.Background(),
		companies.Company{OfficialName: "Acme", Website: "https://acme.example"},
		"",
		Pages{Website: "This company sells widgets."},
	); err != nil {
		t.Fatalf("Build: %v", err)
	}
	if !strings.Contains(client.lastPrompt.User, "BEGIN_UNTRUSTED_WEBSITE_CONTENT") {
		t.Fatalf("expected website content block, got: %s", client.lastPrompt.User)
	}
	if !strings.Contains(client.lastPrompt.User, "This company sells widgets.") {
		t.Fatalf("expected website content, got: %s", client.lastPrompt.User)
	}
}

func TestBuildDossierPromptEmbedsAllThreeBlocksIndependently(t *testing.T) {
	client := &fakeClient{payload: "{}"}
	svc := &Service{client: client}
	if _, err := svc.Build(
		context.Background(),
		companies.Company{OfficialName: "Acme"},
		"",
		Pages{
			Website: "Home page markdown.",
			Blog:    "Blog markdown.",
			Careers: "Careers markdown.",
		},
	); err != nil {
		t.Fatalf("Build: %v", err)
	}
	for _, marker := range []string{
		"BEGIN_UNTRUSTED_WEBSITE_CONTENT", "Home page markdown.",
		"BEGIN_UNTRUSTED_BLOG_CONTENT", "Blog markdown.",
		"BEGIN_UNTRUSTED_CAREERS_CONTENT", "Careers markdown.",
	} {
		if !strings.Contains(client.lastPrompt.User, marker) {
			t.Fatalf("missing marker %q in prompt", marker)
		}
	}
}

func TestBuildDossierPromptSkipsMissingBlocks(t *testing.T) {
	client := &fakeClient{payload: "{}"}
	svc := &Service{client: client}
	if _, err := svc.Build(
		context.Background(),
		companies.Company{OfficialName: "Acme"},
		"",
		Pages{Blog: "Blog only."},
	); err != nil {
		t.Fatalf("Build: %v", err)
	}
	if strings.Contains(client.lastPrompt.User, "BEGIN_UNTRUSTED_WEBSITE_CONTENT") {
		t.Fatalf("expected no website block when empty")
	}
	if strings.Contains(client.lastPrompt.User, "BEGIN_UNTRUSTED_CAREERS_CONTENT") {
		t.Fatalf("expected no careers block when empty")
	}
	if !strings.Contains(client.lastPrompt.User, "BEGIN_UNTRUSTED_BLOG_CONTENT") {
		t.Fatalf("expected blog block, got: %s", client.lastPrompt.User)
	}
}

func TestBuildDossierPromptTruncatesLargeContent(t *testing.T) {
	client := &fakeClient{payload: "{}"}
	svc := &Service{client: client}
	huge := strings.Repeat("x", ScrapedContentMaxBytes+5000)
	if _, err := svc.Build(
		context.Background(),
		companies.Company{OfficialName: "Acme"},
		"",
		Pages{Website: huge},
	); err != nil {
		t.Fatalf("Build: %v", err)
	}
	begin := strings.Index(client.lastPrompt.User, "BEGIN_UNTRUSTED_WEBSITE_CONTENT\n")
	end := strings.Index(client.lastPrompt.User, "\nEND_UNTRUSTED_WEBSITE_CONTENT")
	if begin < 0 || end < 0 {
		t.Fatalf("expected website content block, got: %s", client.lastPrompt.User)
	}
	body := client.lastPrompt.User[begin+len("BEGIN_UNTRUSTED_WEBSITE_CONTENT\n") : end]
	if len(body) != ScrapedContentMaxBytes {
		t.Fatalf("website content not truncated to %d, got len=%d", ScrapedContentMaxBytes, len(body))
	}
}
