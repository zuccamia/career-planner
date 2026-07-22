package dossiers

import (
	"context"
	"errors"
	"testing"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/sources/llm"
)

type fakeRepository struct {
	created Dossier
	latest  Dossier
}

func (f *fakeRepository) Create(ctx context.Context, dossier Dossier) (Dossier, error) {
	f.created = dossier
	return dossier, nil
}
func (f *fakeRepository) GetLatestByCompanyID(ctx context.Context, companyID int64) (Dossier, error) {
	return f.latest, nil
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

func TestBuildRejectsInvalidCompanyID(t *testing.T) {
	svc := NewService(nil, &fakeRepository{})
	_, err := svc.Build(context.Background(), BuildInput{Company: companies.Company{ID: 0}})
	if !errors.Is(err, companies.ErrCompanyNotFound) {
		t.Fatalf("expected ErrCompanyNotFound, got %v", err)
	}
}

func TestBuildWithoutLLMUsesFallback(t *testing.T) {
	repo := &fakeRepository{}
	company := companies.Company{ID: 1, OfficialName: "Acme", Website: "https://acme.test"}
	svc := NewService(nil, repo)

	got, err := svc.Build(context.Background(), BuildInput{Company: company})
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if got.Status != "completed" || repo.created.Status != "completed" {
		t.Fatalf("expected completed status, got %+v", got)
	}
	if repo.created.CareersURL != "https://acme.test/careers" {
		t.Fatalf("expected fallback careers url, got %q", repo.created.CareersURL)
	}
	if repo.created.CompanySummary != "Acme" || repo.created.WhatTheCompanyDoes != "Acme" {
		t.Fatalf("expected fallback text fields, got %+v", repo.created)
	}
}

func TestBuildIgnoresLLMErrorAndStillPersistsFallback(t *testing.T) {
	repo := &fakeRepository{}
	company := companies.Company{ID: 1, OfficialName: "Acme", Website: "https://acme.test"}
	svc := NewService(fakeLLMClient{generate: func(prompt llm.Prompt, out any) error {
		return errors.New("boom")
	}}, repo)

	_, err := svc.Build(context.Background(), BuildInput{Company: company})
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if repo.created.CareersURL != "https://acme.test/careers" || repo.created.CompanySummary != "Acme" {
		t.Fatalf("expected fallback dossier to be persisted, got %+v", repo.created)
	}
}

func TestBuildMergesGeneratedResultWithFallback(t *testing.T) {
	repo := &fakeRepository{}
	company := companies.Company{ID: 1, OfficialName: "Acme", Website: "https://acme.test"}
	svc := NewService(fakeLLMClient{generate: func(prompt llm.Prompt, out any) error {
		result := out.(*llmResult)
		*result = llmResult{
			CompanySummary:        "  Better summary  ",
			TargetCustomers:       []string{" Developers ", "Developers"},
			MajorTechStacks:       MajorTechStacks{Languages: []string{" Go ", "Go"}},
			RecentProductLaunches: []string{"2025-01 | Launch"},
		}
		return nil
	}}, repo)

	_, err := svc.Build(context.Background(), BuildInput{Company: company})
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if repo.created.CompanySummary != "Better summary" {
		t.Fatalf("expected merged company summary, got %q", repo.created.CompanySummary)
	}
	if len(repo.created.TargetCustomers) != 1 || repo.created.TargetCustomers[0] != "Developers" {
		t.Fatalf("expected sanitized target customers, got %+v", repo.created.TargetCustomers)
	}
	if repo.created.CareersURL != "https://acme.test/careers" {
		t.Fatalf("expected fallback careers url to remain, got %q", repo.created.CareersURL)
	}
	if len(repo.created.MajorTechStacks.Languages) != 1 || repo.created.MajorTechStacks.Languages[0] != "Go" {
		t.Fatalf("expected sanitized tech stacks, got %+v", repo.created.MajorTechStacks)
	}
}

func TestGetLatestByCompanyIDRejectsInvalidID(t *testing.T) {
	svc := NewService(nil, &fakeRepository{})
	_, err := svc.GetLatestByCompanyID(context.Background(), 0)
	if !errors.Is(err, companies.ErrCompanyNotFound) {
		t.Fatalf("expected ErrCompanyNotFound, got %v", err)
	}
}
