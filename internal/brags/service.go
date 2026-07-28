package brags

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// GenerateTags runs the brag-tag prompt and returns normalized tags.
func (s *Service) GenerateTags(ctx context.Context, body string) ([]string, error) {
	prompt := s.BuildGenerateTagsPrompt(body)
	if s.client == nil {
		return nil, fmt.Errorf("llm client is not configured")
	}
	var out TagResult
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return nil, err
	}
	return s.FinalizeTags(out), nil
}

// BuildGenerateTagsPrompt assembles the prompt for generating brag tags.
func (s *Service) BuildGenerateTagsPrompt(body string) llm.Prompt {
	trimmed := strings.TrimSpace(body)
	return llm.Prompt{
		System: generateTagsSystemPrompt,
		User:   fmt.Sprintf(generateTagsUserPrompt, trimmed),
	}
}

// FinalizeTags trims, deduplicates, and normalizes decoded tags.
func (s *Service) FinalizeTags(out TagResult) []string {
	seen := map[string]struct{}{}
	tags := make([]string, 0, len(out.Tags))
	for _, raw := range out.Tags {
		tag := strings.ToLower(strings.TrimSpace(raw))
		tag = strings.Join(strings.Fields(tag), " ")
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
		if len(tags) == 7 {
			break
		}
	}
	sort.Strings(tags)
	return tags
}
