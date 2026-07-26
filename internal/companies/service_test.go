package companies

import (
	"context"
	"errors"
	"testing"
)

type fakeRepository struct {
	createInput  CreateCompanyInput
	updateInput  UpdateCompanyInput
	getID        int64
	deleteID     int64
	createCalled bool
	updateCalled bool
	getCalled    bool
	deleteCalled bool
}

func (f *fakeRepository) Count(ctx context.Context) (int, error) { return 0, nil }
func (f *fakeRepository) Create(ctx context.Context, input CreateCompanyInput) (Company, error) {
	f.createCalled = true
	f.createInput = input
	return Company{OfficialName: input.OfficialName}, nil
}
func (f *fakeRepository) Delete(ctx context.Context, id int64) error {
	f.deleteCalled = true
	f.deleteID = id
	return nil
}
func (f *fakeRepository) GetByID(ctx context.Context, id int64) (Company, error) {
	f.getCalled = true
	f.getID = id
	return Company{ID: id}, nil
}
func (f *fakeRepository) List(ctx context.Context) ([]Company, error) { return nil, nil }
func (f *fakeRepository) Update(ctx context.Context, input UpdateCompanyInput) (Company, error) {
	f.updateCalled = true
	f.updateInput = input
	return Company{ID: input.ID, OfficialName: input.OfficialName}, nil
}

func TestServiceCreateSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(nil, repo)

	_, err := svc.Create(context.Background(), CreateCompanyInput{
		OfficialName: "  Stripe  ",
		Website:      " https://stripe.com ",
		TechBlogURL:  " https://stripe.com/blog ",
		ATSURL:       " https://jobs.stripe.com ",
		ATSProvider:  "  Greenhouse  ",
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if !repo.createCalled {
		t.Fatal("expected repo Create to be called")
	}
	if repo.createInput.OfficialName != "Stripe" || repo.createInput.Website != "https://stripe.com" || repo.createInput.TechBlogURL != "https://stripe.com/blog" || repo.createInput.ATSURL != "https://jobs.stripe.com" || repo.createInput.ATSProvider != "Greenhouse" {
		t.Fatalf("unexpected sanitized create input: %+v", repo.createInput)
	}
}

func TestServiceCreateRejectsEmptyOfficialName(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(nil, repo)

	_, err := svc.Create(context.Background(), CreateCompanyInput{OfficialName: "   "})
	if err == nil {
		t.Fatal("expected validation error")
	}
	if err.Error() != "official company name is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.createCalled {
		t.Fatal("repo should not be called on invalid input")
	}
}

func TestServiceUpdateSanitizesInput(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(nil, repo)

	_, err := svc.Update(context.Background(), UpdateCompanyInput{
		ID:           10,
		OfficialName: "  Stripe  ",
		Website:      " https://stripe.com ",
		TechBlogURL:  " https://stripe.com/blog ",
		ATSURL:       " https://jobs.stripe.com ",
		ATSProvider:  "  Ashby  ",
	})
	if err != nil {
		t.Fatalf("Update returned error: %v", err)
	}
	if !repo.updateCalled {
		t.Fatal("expected repo Update to be called")
	}
	if repo.updateInput.OfficialName != "Stripe" || repo.updateInput.Website != "https://stripe.com" || repo.updateInput.TechBlogURL != "https://stripe.com/blog" || repo.updateInput.ATSURL != "https://jobs.stripe.com" || repo.updateInput.ATSProvider != "Ashby" {
		t.Fatalf("unexpected sanitized update input: %+v", repo.updateInput)
	}
}

func TestServiceUpdateRejectsInvalidID(t *testing.T) {
	svc := NewService(nil, &fakeRepository{})
	_, err := svc.Update(context.Background(), UpdateCompanyInput{ID: 0, OfficialName: "Stripe"})
	if !errors.Is(err, ErrCompanyNotFound) {
		t.Fatalf("expected ErrCompanyNotFound, got %v", err)
	}
}

func TestServiceUpdateRejectsEmptyOfficialName(t *testing.T) {
	repo := &fakeRepository{}
	svc := NewService(nil, repo)
	_, err := svc.Update(context.Background(), UpdateCompanyInput{ID: 1, OfficialName: "   "})
	if err == nil || err.Error() != "official company name is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.updateCalled {
		t.Fatal("repo should not be called on invalid input")
	}
}

func TestServiceGetByIDRejectsNonPositiveID(t *testing.T) {
	svc := NewService(nil, &fakeRepository{})
	_, err := svc.GetByID(context.Background(), 0)
	if !errors.Is(err, ErrCompanyNotFound) {
		t.Fatalf("expected ErrCompanyNotFound, got %v", err)
	}
}

func TestServiceDeleteRejectsNonPositiveID(t *testing.T) {
	svc := NewService(nil, &fakeRepository{})
	err := svc.Delete(context.Background(), 0)
	if !errors.Is(err, ErrCompanyNotFound) {
		t.Fatalf("expected ErrCompanyNotFound, got %v", err)
	}
}
