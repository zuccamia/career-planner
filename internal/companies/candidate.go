package companies

// Uses the LLM to infer likely company details from user input.

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// GuessCandidate turns free-form user input into a probable canonical company record for confirmation.
func (s *Service) GuessCandidate(ctx context.Context, input string) (Candidate, error) {
	trimmed := strings.TrimSpace(input)
	fallback := Candidate{OfficialName: trimmed}
	if trimmed == "" {
		return fallback, nil
	}
	if s == nil || s.client == nil {
		return fallback, nil
	}

	prompt := llm.Prompt{
		System: companyCandidateSystemPrompt,
		User:   fmt.Sprintf(companyCandidateUserPrompt, trimmed),
	}

	var candidate Candidate
	if err := s.client.GenerateJSON(ctx, prompt, &candidate); err != nil {
		return fallback, err
	}

	candidate = sanitizeCandidate(candidate, trimmed)
	if candidate.OfficialName == "" {
		candidate.OfficialName = trimmed
	}
	return candidate, nil
}

// sanitizeCandidate trims and URL-normalizes guessed company fields while preserving a fallback name.
func sanitizeCandidate(candidate Candidate, fallbackName string) Candidate {
	candidate.OfficialName = strings.TrimSpace(candidate.OfficialName)
	candidate.Website = sanitizeHTTPURL(candidate.Website)
	candidate.TechBlogURL = sanitizeHTTPURL(candidate.TechBlogURL)
	candidate.ATSURL = sanitizeHTTPURL(candidate.ATSURL)
	candidate.ATSProvider = strings.TrimSpace(candidate.ATSProvider)
	candidate.Reasoning = strings.TrimSpace(candidate.Reasoning)
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
