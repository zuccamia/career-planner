package people

import (
	"context"
	"errors"
	"testing"
)

type fakeRepository struct {
	createInput  CreatePersonInput
	updateInput  UpdatePersonInput
	createCalled bool
	updateCalled bool
}

func (f *fakeRepository) Count(ctx context.Context) (int, error) { return 0, nil }
func (f *fakeRepository) Create(ctx context.Context, input CreatePersonInput) (Person, error) {
	f.createCalled = true
	f.createInput = input
	return Person{FullName: input.FullName}, nil
}
func (f *fakeRepository) Delete(ctx context.Context, id int64) error { return nil }
func (f *fakeRepository) GetByID(ctx context.Context, id int64) (Person, error) {
	return Person{ID: id}, nil
}
func (f *fakeRepository) List(ctx context.Context) ([]Person, error) { return nil, nil }
func (f *fakeRepository) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	return nil, nil
}
func (f *fakeRepository) Update(ctx context.Context, input UpdatePersonInput) (Person, error) {
	f.updateCalled = true
	f.updateInput = input
	return Person{ID: input.ID, FullName: input.FullName}, nil
}

func TestServiceCreateSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo)
	_, err := svc.Create(context.Background(), CreatePersonInput{
		FullName:    "  Jane Doe  ",
		Title:       "  Recruiter  ",
		CompanyID:   2,
		LinkedInURL: " https://linkedin.com/in/jane ",
		Notes:       "  helpful contact  ",
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if repo.createInput.FullName != "Jane Doe" || repo.createInput.Title != "Recruiter" || repo.createInput.LinkedInURL != "https://linkedin.com/in/jane" || repo.createInput.Notes != "helpful contact" {
		t.Fatalf("unexpected sanitized create input: %+v", repo.createInput)
	}
}

func TestServiceCreateNormalizesNegativeCompanyID(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo)
	_, err := svc.Create(context.Background(), CreatePersonInput{FullName: "Jane", CompanyID: -10})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if repo.createInput.CompanyID != 0 {
		t.Fatalf("expected CompanyID to normalize to 0, got %d", repo.createInput.CompanyID)
	}
}

func TestServiceCreateRejectsEmptyFullName(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo)
	_, err := svc.Create(context.Background(), CreatePersonInput{FullName: "   "})
	if err == nil || err.Error() != "full name is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.createCalled {
		t.Fatal("repo should not be called on invalid input")
	}
}

func TestServiceUpdateSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo)
	_, err := svc.Update(context.Background(), UpdatePersonInput{
		ID:          1,
		FullName:    "  Jane Doe  ",
		Title:       "  Recruiter  ",
		CompanyID:   -3,
		LinkedInURL: " https://linkedin.com/in/jane ",
		Notes:       "  helpful contact  ",
	})
	if err != nil {
		t.Fatalf("Update returned error: %v", err)
	}
	if repo.updateInput.FullName != "Jane Doe" || repo.updateInput.Title != "Recruiter" || repo.updateInput.LinkedInURL != "https://linkedin.com/in/jane" || repo.updateInput.Notes != "helpful contact" || repo.updateInput.CompanyID != 0 {
		t.Fatalf("unexpected sanitized update input: %+v", repo.updateInput)
	}
}

func TestServiceUpdateRejectsInvalidID(t *testing.T) {
	svc := NewService(&fakeRepository{})
	_, err := svc.Update(context.Background(), UpdatePersonInput{ID: 0, FullName: "Jane"})
	if !errors.Is(err, ErrPersonNotFound) {
		t.Fatalf("expected ErrPersonNotFound, got %v", err)
	}
}

func TestServiceUpdateRejectsEmptyFullName(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(repo)
	_, err := svc.Update(context.Background(), UpdatePersonInput{ID: 1, FullName: "   "})
	if err == nil || err.Error() != "full name is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.updateCalled {
		t.Fatal("repo should not be called on invalid input")
	}
}

func TestServiceDeleteRejectsInvalidID(t *testing.T) {
	svc := NewService(&fakeRepository{})
	err := svc.Delete(context.Background(), 0)
	if !errors.Is(err, ErrPersonNotFound) {
		t.Fatalf("expected ErrPersonNotFound, got %v", err)
	}
}
