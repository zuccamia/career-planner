package brags

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// GenerateTags runs the brag-tag prompt and returns normalized tags.
// outputLanguage selects the locale-specific prompt template; missing locales
// fall back to English.
func (s *Service) GenerateTags(ctx context.Context, body, outputLanguage string) ([]string, error) {
	prompt := s.BuildGenerateTagsPrompt(body, outputLanguage)
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
func (s *Service) BuildGenerateTagsPrompt(body, outputLanguage string) llm.Prompt {
	set := llm.PickPromptSet(generateTagsPrompts, outputLanguage)
	trimmed := strings.TrimSpace(body)
	return llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, trimmed),
	}
}

// FinalizeTags trims, deduplicates, and normalizes decoded tags.
func (s *Service) FinalizeTags(out TagResult) []string {
	seen := map[string]struct{}{}
	tags := make([]string, 0, len(out.Tags))
	for _, raw := range out.Tags {
		tag := strings.ToLower(strings.TrimSpace(raw))
		tag = strings.Join(strings.Fields(tag), " ")
		if llm.IsSuspiciousText(tag) {
			continue
		}
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

// ExtractFromResume runs the résumé-to-brags prompt against a Markdown résumé
// and returns candidate brag entries for the browser to review. The DB writes
// happen in the browser after the user picks which entries to keep.
func (s *Service) ExtractFromResume(ctx context.Context, markdown, outputLanguage string) ([]ExtractedBrag, error) {
	prompt := s.BuildExtractFromResumePrompt(markdown, outputLanguage)
	if s.client == nil {
		return nil, fmt.Errorf("llm client is not configured")
	}
	var out ExtractResumeResult
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return nil, err
	}
	return s.FinalizeExtracted(out), nil
}

// BuildExtractFromResumePrompt assembles the prompt for résumé-to-brags
// extraction. The Markdown is passed verbatim (fenced in the prompt template
// as untrusted input).
func (s *Service) BuildExtractFromResumePrompt(markdown, outputLanguage string) llm.Prompt {
	set := llm.PickPromptSet(extractFromResumePrompts, outputLanguage)
	trimmed := strings.TrimSpace(markdown)
	return llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, trimmed),
	}
}

// FinalizeExtracted normalizes decoded résumé extraction output: trims all
// string fields, drops entries with an empty title, clamps confidence to
// [0, 1], and re-uses FinalizeTags for per-entry tag cleanup. It also
// deduplicates on a normalized (title, body) key so retries with slight
// variance don't produce visible duplicates in the review UI.
func (s *Service) FinalizeExtracted(out ExtractResumeResult) []ExtractedBrag {
	entries := make([]ExtractedBrag, 0, len(out.Brags))
	seen := map[string]struct{}{}
	for _, raw := range out.Brags {
		title := strings.TrimSpace(raw.Title)
		body := strings.TrimSpace(raw.Body)
		if title == "" || llm.IsSuspiciousText(title) || llm.IsSuspiciousText(body) {
			continue
		}
		impact := strings.TrimSpace(raw.Impact)
		if llm.IsSuspiciousText(impact) {
			impact = ""
		}
		companyHint := strings.TrimSpace(raw.Company)
		if llm.IsSuspiciousText(companyHint) {
			companyHint = ""
		}
		var entryYear *int
		if raw.EntryYear != nil && *raw.EntryYear >= 1970 && *raw.EntryYear <= 2100 {
			y := *raw.EntryYear
			entryYear = &y
		}
		conf := raw.Confidence
		if conf < 0 {
			conf = 0
		} else if conf > 1 {
			conf = 1
		}
		key := strings.ToLower(strings.Join(strings.Fields(title+" "+body), " "))
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		entries = append(entries, ExtractedBrag{
			Title:      title,
			Body:       body,
			Impact:     impact,
			Tags:       s.FinalizeTags(TagResult{Tags: raw.Tags}),
			Company:    companyHint,
			EntryYear:  entryYear,
			Confidence: conf,
		})
	}
	return entries
}
