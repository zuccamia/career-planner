package ats

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/util"
)

const leverAPIBase = "https://api.lever.co"

// Lever fetches postings via Lever's public postings API. Handles the host
// jobs.lever.co.
type Lever struct {
	client  *http.Client
	apiBase string // override for tests
}

// NewLever returns a Lever provider with a sensible HTTP client.
func NewLever() *Lever {
	return &Lever{
		client:  safeClient(),
		apiBase: leverAPIBase,
	}
}

func (*Lever) Name() string { return "lever" }

func (*Lever) Supports(rawURL string) bool {
	_, _, ok := parseLeverURL(rawURL)
	return ok
}

func (l *Lever) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	company, id, ok := parseLeverURL(rawURL)
	if !ok {
		return Posting{}, fmt.Errorf("not a recognized lever url: %s", rawURL)
	}

	base := l.apiBase
	if base == "" {
		base = leverAPIBase
	}
	apiURL := fmt.Sprintf("%s/v0/postings/%s/%s?mode=json", strings.TrimRight(base, "/"), url.PathEscape(company), url.PathEscape(id))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return Posting{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")
	req.Header.Set("Accept", "application/json")

	body, err := fetchPostingBody(l.client, req, "lever", 2<<20)
	if err != nil {
		return Posting{}, err
	}

	var payload leverPosting
	if err := json.Unmarshal(body, &payload); err != nil {
		return Posting{}, fmt.Errorf("decode lever response: %w", err)
	}

	// Assemble description from the HTML fields so bullet lists survive.
	var parts []string
	if payload.Description != "" {
		parts = append(parts, payload.Description)
	}
	for _, section := range payload.Lists {
		if section.Text != "" {
			parts = append(parts, "<h3>"+section.Text+"</h3>")
		}
		if section.Content != "" {
			parts = append(parts, section.Content)
		}
	}
	if payload.Additional != "" {
		parts = append(parts, payload.Additional)
	}
	description := htmlToText(strings.Join(parts, "\n"))
	if description == "" {
		return Posting{}, fmt.Errorf("lever response contained no description")
	}

	// Lever's createdAt is unix millis. Zero-value is a rare but valid
	// "unknown" signal from the API side too — treat 0 as unknown.
	var postedAt time.Time
	if payload.CreatedAt > 0 {
		postedAt = time.UnixMilli(payload.CreatedAt).UTC()
	}

	return Posting{
		Provider:        "lever",
		Title:           strings.TrimSpace(payload.Text),
		Location:        strings.TrimSpace(payload.Categories.Location),
		Department:      util.FirstNonEmpty(payload.Categories.Department, payload.Categories.Team),
		Team:            strings.TrimSpace(payload.Categories.Team),
		ApplyURL:        strings.TrimSpace(util.FirstNonEmpty(payload.ApplyURL, payload.HostedURL)),
		DescriptionText: description,
		EmploymentType:  strings.TrimSpace(payload.Categories.Commitment),
		PostedAt:        postedAt,
	}, nil
}

type leverPosting struct {
	Text        string `json:"text"`
	HostedURL   string `json:"hostedUrl"`
	ApplyURL    string `json:"applyUrl"`
	CreatedAt   int64  `json:"createdAt"`
	Description string `json:"description"`
	Additional  string `json:"additional"`
	Lists       []struct {
		Text    string `json:"text"`
		Content string `json:"content"`
	} `json:"lists"`
	Categories struct {
		Team       string `json:"team"`
		Department string `json:"department"`
		Location   string `json:"location"`
		Commitment string `json:"commitment"`
	} `json:"categories"`
}

// parseLeverURL extracts (company, postingID) from a Lever posting URL:
//   - https://jobs.lever.co/{company}/{id}
func parseLeverURL(rawURL string) (company, id string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", "", false
	}
	if strings.ToLower(parsed.Host) != "jobs.lever.co" {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}
