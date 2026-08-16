package ats

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/util"
)

const greenhouseAPIBase = "https://boards-api.greenhouse.io"

// Greenhouse fetches postings via Greenhouse's public boards API rather than
// scraping HTML. Handles hosts boards.greenhouse.io and job-boards.greenhouse.io.
type Greenhouse struct {
	client  *http.Client
	apiBase string // override for tests
}

// NewGreenhouse returns a Greenhouse provider with a sensible HTTP client.
func NewGreenhouse() *Greenhouse {
	return &Greenhouse{
		client:  safeClient(),
		apiBase: greenhouseAPIBase,
	}
}

func (*Greenhouse) Name() string { return "greenhouse" }

func (*Greenhouse) Supports(rawURL string) bool {
	_, _, ok := parseGreenhouseURL(rawURL)
	return ok
}

func (g *Greenhouse) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	board, id, ok := parseGreenhouseURL(rawURL)
	if !ok {
		return Posting{}, fmt.Errorf("not a recognized greenhouse url: %s", rawURL)
	}

	base := g.apiBase
	if base == "" {
		base = greenhouseAPIBase
	}
	apiURL := fmt.Sprintf("%s/v1/boards/%s/jobs/%s", strings.TrimRight(base, "/"), url.PathEscape(board), url.PathEscape(id))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return Posting{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")
	req.Header.Set("Accept", "application/json")

	// 2 MiB fits Greenhouse's largest observed JSON payloads (long
	// descriptions + department metadata) with headroom.
	body, err := fetchPostingBody(g.client, req, "greenhouse", 2<<20)
	if err != nil {
		return Posting{}, err
	}

	var payload greenhouseJob
	if err := json.Unmarshal(body, &payload); err != nil {
		return Posting{}, fmt.Errorf("decode greenhouse response: %w", err)
	}

	description := htmlToText(html.UnescapeString(payload.Content))
	if description == "" {
		return Posting{}, fmt.Errorf("greenhouse response contained no description")
	}

	posting := Posting{
		Provider:        "greenhouse",
		Title:           strings.TrimSpace(payload.Title),
		Company:         strings.TrimSpace(payload.CompanyName),
		Location:        strings.TrimSpace(payload.Location.Name),
		ApplyURL:        strings.TrimSpace(payload.AbsoluteURL),
		DescriptionText: description,
		PostedAt: util.ParseTimestamp(
			[]string{time.RFC3339Nano, time.RFC3339, "2006-01-02"},
			payload.FirstPublished, payload.UpdatedAt,
		),
	}
	if len(payload.Departments) > 0 {
		posting.Department = strings.TrimSpace(payload.Departments[0].Name)
	}
	return posting, nil
}

type greenhouseJob struct {
	Title          string `json:"title"`
	CompanyName    string `json:"company_name"`
	AbsoluteURL    string `json:"absolute_url"`
	Content        string `json:"content"`
	FirstPublished string `json:"first_published"`
	UpdatedAt      string `json:"updated_at"`
	Location       struct {
		Name string `json:"name"`
	} `json:"location"`
	Departments []struct {
		Name string `json:"name"`
	} `json:"departments"`
}

// parseGreenhouseURL extracts (board, jobID) from a Greenhouse posting URL.
// Recognized shapes:
//   - https://boards.greenhouse.io/{board}/jobs/{id}
//   - https://job-boards.greenhouse.io/{board}/jobs/{id}
func parseGreenhouseURL(rawURL string) (board, id string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", "", false
	}
	host := strings.ToLower(parsed.Host)
	if host != "boards.greenhouse.io" && host != "job-boards.greenhouse.io" {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 3 || parts[1] != "jobs" {
		return "", "", false
	}
	if parts[0] == "" || parts[2] == "" {
		return "", "", false
	}
	return parts[0], parts[2], true
}
