package companies

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/ngochoang/career-planner/internal/llm"
)

type Candidate struct {
	OfficialName string  `json:"official_name"`
	Website      string  `json:"website"`
	ATSURL       string  `json:"ats_url"`
	ATSProvider  string  `json:"ats_provider"`
	Confidence   float64 `json:"confidence"`
	Reasoning    string  `json:"reasoning"`
}

type Service struct {
	client llm.Client
}

func NewService(client llm.Client) *Service {
	return &Service{client: client}
}

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

func sanitizeCandidate(candidate Candidate, fallbackName string) Candidate {
	candidate.OfficialName = strings.TrimSpace(candidate.OfficialName)
	candidate.Website = sanitizeURL(candidate.Website)
	candidate.ATSURL = sanitizeURL(candidate.ATSURL)
	candidate.ATSProvider = strings.TrimSpace(candidate.ATSProvider)
	candidate.Reasoning = strings.TrimSpace(candidate.Reasoning)
	if candidate.Confidence < 0 {
		candidate.Confidence = 0
	}
	if candidate.Confidence > 1 {
		candidate.Confidence = 1
	}
	if candidate.OfficialName == "" {
		candidate.OfficialName = fallbackName
	}
	return candidate
}

func sanitizeURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.String()
}

const companyCandidateSystemPrompt = `You identify one best-effort company candidate from a user-provided company name.
Return valid JSON only.
Do not include markdown.
Prefer incomplete fields over guessing.
Prefer the official company website over directory or profile sites.
If the ATS URL or ATS provider is uncertain, leave it empty.`

const companyCandidateUserPrompt = `Company name entered by user: %q

Return exactly one JSON object with these keys:
- official_name
- website
- ats_url
- ats_provider
- confidence
- reasoning

Rules:
- confidence must be a number between 0 and 1
- leave website empty if uncertain
- leave ats_url empty if uncertain
- leave ats_provider empty if uncertain
- prefer partial accuracy over hallucination`