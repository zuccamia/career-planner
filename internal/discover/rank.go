package discover

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/util"
)

const (
	minMatchScore = 0
	maxMatchScore = 100
)

// Length caps for JobPosting fields before they hit the ranker prompt.
const (
	capPostingTitle   = 200
	capPostingSnippet = 2000 // wide enough for "About the role" + "What you'll do" + a few "Requirements" bullets
	capPostingCompany = 200
)

// capPostings returns a copy of postings with prompt-visible fields truncated.
// json:"-" fields (BoardURL, Provider, PostedAt) don't enter the prompt.
func capPostings(in []JobPosting) []JobPosting {
	out := make([]JobPosting, len(in))
	for i, p := range in {
		p.Title = truncate(p.Title, capPostingTitle)
		p.Snippet = truncate(p.Snippet, capPostingSnippet)
		p.Company = truncate(p.Company, capPostingCompany)
		out[i] = p
	}
	return out
}

type rankResponse struct {
	Recommendations []Recommendation `json:"recommendations"`
}

type rankContext struct {
	Profile        ProfileSummary  `json:"profile"`
	Postings       []JobPosting    `json:"postings"`
	Limit          int             `json:"limit"`
	EmploymentType string          `json:"employment_type,omitempty"`
	Location       LocationContext `json:"location"`
}

func (s *Service) rankPostings(ctx context.Context, req DiscoverRequest, postings []JobPosting, limit int) ([]Recommendation, error) {
	if len(postings) == 0 {
		return nil, nil
	}
	blob, err := json.Marshal(rankContext{
		Profile:        req.Profile,
		Postings:       capPostings(postings),
		Limit:          limit,
		EmploymentType: req.Profile.EmploymentType,
		Location:       deriveLocationContext(req.Profile.Locations),
	})
	if err != nil {
		return nil, fmt.Errorf("marshal rank context: %w", err)
	}
	set := llm.PickPromptSet(rankJobsPrompts(), req.Locale)
	prompt := llm.Prompt{System: set.System, User: fmt.Sprintf(set.User, string(blob))}
	var out rankResponse
	if err := s.llm.GenerateJSON(ctx, prompt, &out); err != nil {
		return nil, fmt.Errorf("rank-jobs llm: %w", err)
	}

	// URL whitelist: recs must reference postings we sent (block hallucinated URLs).
	allowed := make(map[string]JobPosting, len(postings))
	for _, p := range postings {
		if key := normalizeURL(p.URL); key != "" {
			allowed[key] = p
		}
	}
	cleaned := make([]Recommendation, 0, len(out.Recommendations))
	for _, r := range out.Recommendations {
		url := strings.TrimSpace(r.URL)
		title := strings.TrimSpace(r.Title)
		if url == "" || title == "" {
			continue
		}
		origin, ok := allowed[normalizeURL(url)]
		if !ok {
			continue
		}
		if r.MatchScore < minMatchScore {
			r.MatchScore = minMatchScore
		}
		if r.MatchScore > maxMatchScore {
			r.MatchScore = maxMatchScore
		}
		company := util.FirstNonEmpty(strings.TrimSpace(r.Company), origin.Company, companyFromURL(url))
		cleaned = append(cleaned, Recommendation{
			Title:      title,
			Company:    company,
			URL:        url,
			MatchScore: r.MatchScore,
			Rationale:  llm.SanitizeText(r.Rationale),
			Provider:   origin.Provider,
			BoardURL:   origin.BoardURL,
			PostedAt:   origin.PostedAt,
		})
		if len(cleaned) >= limit {
			break
		}
	}
	return cleaned, nil
}
