package discover

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

const (
	maxRoleVariants   = 5
	maxSignalKeywords = 5
)

type expandResponse struct {
	RoleVariants   []string `json:"role_variants"`
	SignalKeywords []string `json:"signal_keywords"`
	BroadRole      string   `json:"broad_role"`
}

func (r expandResponse) toSignals() SearchSignals {
	return SearchSignals{
		RoleVariants:   sanitizeKeywords(r.RoleVariants, maxRoleVariants),
		SignalKeywords: sanitizeKeywords(r.SignalKeywords, maxSignalKeywords),
		BroadRole:      strings.TrimSpace(r.BroadRole),
	}
}

// applyHeadlineFallback ensures RoleVariants is non-empty by falling back to
// the profile headline. The LLM's job is to broaden recall; if it whiffed,
// the headline alone still points search somewhere.
func applyHeadlineFallback(signals SearchSignals, headline string) SearchSignals {
	if len(signals.RoleVariants) == 0 {
		if h := strings.TrimSpace(headline); h != "" {
			signals.RoleVariants = []string{h}
		}
	}
	return signals
}

type expandContext struct {
	Profile        ProfileSummary  `json:"profile"`
	SeedCompanies  []string        `json:"seed_companies"`
	BragTitles     []string        `json:"brag_titles,omitempty"`
	CareerSparks   []string        `json:"career_sparks,omitempty"`
	EmploymentType string          `json:"employment_type,omitempty"`
	Location       LocationContext `json:"location"`
}

func (s *Service) expandSearchSignals(ctx context.Context, req DiscoverRequest) (SearchSignals, error) {
	seedNames := make([]string, 0, len(req.Companies))
	for _, c := range req.Companies {
		if name := strings.TrimSpace(c.Name); name != "" {
			seedNames = append(seedNames, name)
		}
	}
	blob, err := json.Marshal(expandContext{
		Profile:        req.Profile,
		SeedCompanies:  seedNames,
		BragTitles:     req.BragTitles,
		CareerSparks:   req.CareerSparks,
		EmploymentType: strings.TrimSpace(req.Profile.EmploymentType),
		Location:       deriveLocationContext(req.Profile.Locations),
	})
	if err != nil {
		return SearchSignals{}, fmt.Errorf("marshal expand context: %w", err)
	}
	set := llm.PickPromptSet(expandCandidatePrompts(), req.Locale)
	prompt := llm.Prompt{System: set.System, User: fmt.Sprintf(set.User, string(blob))}
	var out expandResponse
	if err := s.llm.GenerateJSON(ctx, prompt, &out); err != nil {
		return SearchSignals{}, fmt.Errorf("expand-signals llm: %w", err)
	}
	return applyHeadlineFallback(out.toSignals(), req.Profile.Headline), nil
}

func sanitizeKeywords(in []string, limit int) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, v := range in {
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, llm.SanitizeText(trimmed))
		if len(out) >= limit {
			break
		}
	}
	return out
}
