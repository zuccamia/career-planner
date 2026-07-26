package ats

import (
	"context"
	"errors"
	"testing"
)

type stubProvider struct {
	name     string
	supports func(string) bool
	posting  Posting
	err      error
}

func (s *stubProvider) Name() string                { return s.name }
func (s *stubProvider) Supports(rawURL string) bool { return s.supports(rawURL) }
func (s *stubProvider) Fetch(_ context.Context, _ string) (Posting, error) {
	return s.posting, s.err
}

func TestRegistryPicksFirstSupportingProvider(t *testing.T) {
	greenhouse := &stubProvider{
		name:     "greenhouse",
		supports: func(u string) bool { return u == "gh" },
		posting:  Posting{Provider: "greenhouse", Title: "Engineer"},
	}
	lever := &stubProvider{
		name:     "lever",
		supports: func(u string) bool { return u == "lever" },
		posting:  Posting{Provider: "lever"},
	}
	fallback := &stubProvider{
		name:     "generic",
		supports: func(string) bool { return true },
		posting:  Posting{Provider: "generic"},
	}
	reg := NewRegistry(fallback, greenhouse, lever)

	got, err := reg.Fetch(context.Background(), "gh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "greenhouse" || got.Title != "Engineer" {
		t.Errorf("got %+v, want greenhouse", got)
	}
}

func TestRegistryFallsBackWhenNoneSupport(t *testing.T) {
	fallback := &stubProvider{
		name:     "generic",
		supports: func(string) bool { return true },
		posting:  Posting{Provider: "generic", DescriptionText: "body"},
	}
	reg := NewRegistry(fallback)

	got, err := reg.Fetch(context.Background(), "https://unknown.example/x")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "generic" || got.DescriptionText != "body" {
		t.Errorf("got %+v, want generic fallback", got)
	}
}

func TestRegistryErrorsWhenNoFallbackAndNoMatch(t *testing.T) {
	reg := NewRegistry(nil)
	_, err := reg.Fetch(context.Background(), "https://x")
	if err == nil {
		t.Fatal("expected error when no fallback and no match")
	}
}

func TestRegistryPropagatesProviderError(t *testing.T) {
	boom := errors.New("upstream down")
	fallback := &stubProvider{
		name:     "generic",
		supports: func(string) bool { return true },
		err:      boom,
	}
	reg := NewRegistry(fallback)
	_, err := reg.Fetch(context.Background(), "x")
	if !errors.Is(err, boom) {
		t.Fatalf("got %v, want %v", err, boom)
	}
}
