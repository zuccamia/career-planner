package companies

// Uses the LLM to infer likely company details from user input.

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// GuessCandidate turns free-form user input into a probable canonical company
// record for confirmation. Composed from BuildCandidatePrompt + FinalizeCandidate
// so the BYOK path can call each half independently.
func (s *Service) GuessCandidate(ctx context.Context, input, outputLanguage string) (Candidate, error) {
	prompt, fallback, skip := s.BuildCandidatePrompt(input, outputLanguage)
	if skip || s == nil || s.client == nil {
		return fallback, nil
	}
	var candidate Candidate
	if err := s.client.GenerateJSON(ctx, prompt, &candidate); err != nil {
		return fallback, err
	}
	return s.FinalizeCandidate(candidate, input), nil
}

// BuildCandidatePrompt assembles the LLM prompt for GuessCandidate along with
// the fallback to return when the LLM should be skipped (empty input). skip=true
// means the caller should return fallback without invoking the LLM.
// outputLanguage selects the locale-specific prompt template; missing locales
// fall back to English.
func (s *Service) BuildCandidatePrompt(input, outputLanguage string) (llm.Prompt, Candidate, bool) {
	trimmed := strings.TrimSpace(input)
	fallback := Candidate{OfficialName: trimmed}
	if trimmed == "" {
		return llm.Prompt{}, fallback, true
	}
	set := llm.PickPromptSet(companyCandidatePrompts, outputLanguage)
	return llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, trimmed),
	}, fallback, false
}

// FinalizeCandidate applies sanitization + fallback logic to a decoded LLM
// candidate. Pure — no I/O. Runs on both hosted and BYOK paths.
func (s *Service) FinalizeCandidate(candidate Candidate, input string) Candidate {
	trimmed := strings.TrimSpace(input)
	candidate = sanitizeCandidate(candidate, trimmed)
	if candidate.OfficialName == "" {
		candidate.OfficialName = trimmed
	}
	return candidate
}

// sanitizeCandidate trims and URL-normalizes guessed company fields while preserving a fallback name.
func sanitizeCandidate(candidate Candidate, fallbackName string) Candidate {
	candidate.OfficialName = strings.TrimSpace(candidate.OfficialName)
	candidate.Website = sanitizeHTTPURL(candidate.Website)
	candidate.BlogURL = sanitizeHTTPURL(candidate.BlogURL)
	candidate.ATSURL = sanitizeHTTPURL(candidate.ATSURL)
	candidate.ATSProvider = strings.TrimSpace(candidate.ATSProvider)
	candidate.Reasoning = llm.SanitizeText(candidate.Reasoning)
	if candidate.OfficialName == "" {
		candidate.OfficialName = fallbackName
	}
	return candidate
}

// sanitizeHTTPURL returns the input only if it parses as an http(s) URL.
func sanitizeHTTPURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	return parsed.String()
}
