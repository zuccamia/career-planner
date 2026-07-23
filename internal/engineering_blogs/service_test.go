package engineering_blogs

import (
	"context"
	"testing"
	"time"
)

type fakeRepository struct{}

func (f *fakeRepository) Count(ctx context.Context) (int, error) { return 0, nil }
func (f *fakeRepository) Create(ctx context.Context, input CreateInput) (Note, error) {
	return Note{}, nil
}
func (f *fakeRepository) Delete(ctx context.Context, id int64) error          { return nil }
func (f *fakeRepository) GetByID(ctx context.Context, id int64) (Note, error) { return Note{}, nil }
func (f *fakeRepository) List(ctx context.Context) ([]Note, error)            { return nil, nil }
func (f *fakeRepository) ListDailyCreatedCounts(ctx context.Context, from, to time.Time) ([]DailyCount, error) {
	return []DailyCount{{Day: from, Count: 2}}, nil
}
func (f *fakeRepository) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	return nil, nil
}
func (f *fakeRepository) ListByCompanyID(ctx context.Context, companyID int64) ([]Note, error) {
	return nil, nil
}
func (f *fakeRepository) Update(ctx context.Context, input UpdateInput) (Note, error) {
	return Note{}, nil
}

func TestListDailyCreatedCountsRejectsInvalidRange(t *testing.T) {
	svc := NewService(&fakeRepository{})
	counts, err := svc.ListDailyCreatedCounts(context.Background(), time.Time{}, time.Now().UTC())
	if err != nil {
		t.Fatalf("ListDailyCreatedCounts returned error: %v", err)
	}
	if len(counts) != 0 {
		t.Fatalf("expected no counts for invalid range, got %+v", counts)
	}
}

func TestListDailyCreatedCountsDelegatesToRepository(t *testing.T) {
	svc := NewService(&fakeRepository{})
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 14)
	counts, err := svc.ListDailyCreatedCounts(context.Background(), from, to)
	if err != nil {
		t.Fatalf("ListDailyCreatedCounts returned error: %v", err)
	}
	if len(counts) != 1 || counts[0].Count != 2 {
		t.Fatalf("unexpected counts: %+v", counts)
	}
}
