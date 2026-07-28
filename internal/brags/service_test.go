package brags

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

type fakeLLM struct {
	payload string
	err     error
	last    llm.Prompt
}

func (f *fakeLLM) GenerateJSON(_ context.Context, p llm.Prompt, out any) error {
	f.last = p
	if f.err != nil {
		return f.err
	}
	return json.Unmarshal([]byte(f.payload), out)
}

func TestBuildGenerateTagsPromptTrimsBody(t *testing.T) {
	svc := NewService(nil)
	p := svc.BuildGenerateTagsPrompt("  shipped feature flags  ")
	if !strings.Contains(p.User, "shipped feature flags") {
		t.Fatal("expected trimmed body in prompt")
	}
}

func TestBuildGenerateTagsPromptIncludesBodyOnly(t *testing.T) {
	svc := NewService(nil)
	p := svc.BuildGenerateTagsPrompt("Shipped feature flags to production")
	if p.System == "" || p.User == "" {
		t.Fatal("prompt should include system and user text")
	}
	if want := "Shipped feature flags to production"; !strings.Contains(p.User, want) {
		t.Fatalf("user prompt missing body %q", want)
	}
	lower := strings.ToLower(p.System + "\n" + p.User)
	if strings.Contains(lower, "impact") {
		t.Fatal("prompt should not mention impact")
	}
	if strings.Contains(lower, "separate field") {
		t.Fatal("prompt should not mention separate fields")
	}
}

func TestFinalizeTagsNormalizesDedupesAndCaps(t *testing.T) {
	svc := NewService(nil)
	got := svc.FinalizeTags(TagResult{Tags: []string{" Observability ", "incident response", "observability", "feature flags", "on-call", "mentoring", "go", "alerts", "extra"}})
	want := []string{"alerts", "feature flags", "go", "incident response", "mentoring", "observability", "on-call"}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tag[%d] = %q, want %q (all=%v)", i, got[i], want[i], got)
		}
	}
}

func TestGenerateTagsReturnsNormalizedTags(t *testing.T) {
	f := &fakeLLM{payload: `{"tags":[" Feature Flags ","observability","feature flags"]}`}
	svc := NewService(f)
	got, err := svc.GenerateTags(context.Background(), "Rolled out behind feature flags and improved dashboards")
	if err != nil {
		t.Fatalf("GenerateTags: %v", err)
	}
	want := []string{"feature flags", "observability"}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tag[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestGenerateTagsPropagatesLLMError(t *testing.T) {
	svc := NewService(&fakeLLM{err: errors.New("boom")})
	if _, err := svc.GenerateTags(context.Background(), "foo"); err == nil {
		t.Fatal("expected error")
	}
}
