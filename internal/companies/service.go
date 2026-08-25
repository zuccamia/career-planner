package companies

// LLM-backed business logic for the companies module: turning free-form user
// input into a probable Candidate, and generating a Dossier from company data
// plus optional pre-scraped page markdown. Neither entry point touches a
// database — the browser owns persistence.

import (
	"context"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// =============================================================================
// Candidate lookup
// =============================================================================

// GuessCandidate turns free-form user input into a probable canonical company
// record for confirmation. Empty input or a nil LLM client returns a fallback
// candidate populated from the input itself.
func (s *Service) GuessCandidate(ctx context.Context, input, outputLanguage string) (Candidate, error) {
	trimmed := strings.TrimSpace(input)
	fallback := Candidate{OfficialName: trimmed}
	if trimmed == "" || s == nil || s.client == nil {
		return fallback, nil
	}
	set := llm.PickPromptSet(lookupCompanyPrompts(), outputLanguage)
	prompt := llm.Prompt{System: set.System, User: fmt.Sprintf(set.User, trimmed)}
	var candidate Candidate
	if err := s.client.GenerateJSON(ctx, prompt, &candidate); err != nil {
		return fallback, err
	}
	return sanitizeCandidate(candidate, trimmed), nil
}

// =============================================================================
// Dossier build
// =============================================================================

// BuildDossier generates a dossier for a company via the LLM without
// persisting it. `pages` carries optional pre-scraped markdown for the
// website/blog/careers URLs — empty fields are omitted from the prompt.
func (s *Service) BuildDossier(ctx context.Context, company Company, outputLanguage string, pages Pages) (Dossier, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return Dossier{}, err
	}
	set := llm.PickPromptSet(buildDossierPrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User: fmt.Sprintf(
			set.User,
			company.OfficialName,
			company.Website,
			company.ATSURL,
			company.ATSProvider,
			formatScrapedBlock("WEBSITE_CONTENT", pages.Website),
			formatScrapedBlock("BLOG_CONTENT", pages.Blog),
			formatScrapedBlock("CAREERS_CONTENT", pages.Careers),
		),
	}
	var generated dossierLLMResult
	if err := s.client.GenerateJSON(ctx, prompt, &generated); err != nil {
		return Dossier{}, fmt.Errorf("generate dossier: %w", err)
	}
	return finalizeDossier(generated), nil
}
