package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/util"
)

const careerpuckAPIBase = "https://api.careerpuck.com"

// Careerpuck fetches postings from Puck-hosted job boards
// (app.careerpuck.com/job-board/{board}/job/{id}). Puck is a career-site
// frontend over other ATSes (Greenhouse, Lever, JazzHR, etc.); we hit the
// public board API and pick out the requested posting by its permalink or
// its upstream ATS source id — Puck's own URLs use the latter.
type Careerpuck struct {
	client  *http.Client
	apiBase string // override for tests
}

func NewCareerpuck() *Careerpuck {
	return &Careerpuck{
		client:  util.SafeClient(),
		apiBase: careerpuckAPIBase,
	}
}

func (*Careerpuck) Name() string { return "careerpuck" }

func (*Careerpuck) Supports(rawURL string) bool {
	_, _, ok := parseCareerpuckURL(rawURL)
	return ok
}

func (c *Careerpuck) Fetch(ctx context.Context, rawURL string) (ats.Posting, error) {
	board, jobID, ok := parseCareerpuckURL(rawURL)
	if !ok {
		return ats.Posting{}, fmt.Errorf("not a recognized careerpuck url: %s", rawURL)
	}

	base := c.apiBase
	if base == "" {
		base = careerpuckAPIBase
	}
	apiURL := fmt.Sprintf("%s/v1/public/job-boards/%s", strings.TrimRight(base, "/"), url.PathEscape(board))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return ats.Posting{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")
	req.Header.Set("Accept", "application/json")

	// No single-job endpoint: the API returns the whole board. Observed
	// payloads sit around 200 KB for large boards (~200 jobs); 4 MiB gives
	// generous headroom.
	body, err := fetchPostingBody(c.client, req, "careerpuck", 4<<20)
	if err != nil {
		return ats.Posting{}, err
	}

	var payload careerpuckBoard
	if err := json.Unmarshal(body, &payload); err != nil {
		return ats.Posting{}, fmt.Errorf("decode careerpuck response: %w", err)
	}

	var match *careerpuckJob
	for i := range payload.Jobs {
		j := &payload.Jobs[i]
		if j.Permalink == jobID || j.ATSSourceID == jobID {
			match = j
			break
		}
	}
	if match == nil {
		return ats.Posting{}, fmt.Errorf("careerpuck: %w: %s", ats.ErrPostingNotFound, rawURL)
	}

	// Puck double-encodes: `content` is HTML with entities also entity-encoded
	// (e.g. "&lt;p&gt;", plus named entities like &comma;, &sol;, &NewLine;).
	// UnescapeString handles all HTML5 named entities per spec.
	description := htmlToText(html.UnescapeString(match.Content))
	if description == "" {
		return ats.Posting{}, fmt.Errorf("careerpuck response contained no description")
	}

	company := strings.TrimSpace(payload.EmployerProfile.Name)
	department := strings.TrimSpace(match.Department)
	if department == "" && len(match.Departments) > 0 {
		department = strings.TrimSpace(match.Departments[0].Name)
	}
	location := strings.TrimSpace(match.Location)
	if location == "" && len(match.Offices) > 0 {
		location = strings.TrimSpace(match.Offices[0].Name)
	}
	applyURL := strings.TrimSpace(match.PublicURL)
	if applyURL == "" {
		applyURL = rawURL
	}

	return ats.Posting{
		Provider:        "careerpuck",
		Title:           strings.TrimSpace(match.Title),
		Company:         company,
		Location:        location,
		Department:      department,
		Team:            strings.TrimSpace(match.Team),
		Compensation:    strings.TrimSpace(match.SalaryDescription),
		ApplyURL:        applyURL,
		DescriptionText: description,
		EmploymentType:  strings.TrimSpace(match.WorkType),
		PostedAt: util.ParseTimestamp(
			[]string{time.RFC3339Nano, time.RFC3339, "2006-01-02"},
			match.PostedAt,
		),
	}, nil
}

type careerpuckBoard struct {
	Jobs            []careerpuckJob `json:"jobs"`
	EmployerProfile struct {
		Name string `json:"name"`
	} `json:"employerProfile"`
}

type careerpuckJob struct {
	Permalink         string `json:"permalink"`
	ATSSourceID       string `json:"atsSourceId"`
	Title             string `json:"title"`
	Content           string `json:"content"`
	Location          string `json:"location"`
	Team              string `json:"team"`
	Department        string `json:"department"`
	WorkType          string `json:"workType"`
	SalaryDescription string `json:"salaryDescription"`
	PublicURL         string `json:"publicUrl"`
	PostedAt          string `json:"postedAt"`
	Offices           []struct {
		Name string `json:"name"`
	} `json:"offices"`
	Departments []struct {
		Name string `json:"name"`
	} `json:"departments"`
}

// parseCareerpuckURL extracts (board, jobID) from a Puck posting URL.
// Recognized shape:
//   - https://app.careerpuck.com/job-board/{board}/job/{jobID}
//
// jobID is opaque and may be either the short permalink (e.g. "SdorDguK") or
// the numeric upstream ATS source id (e.g. "8174947") — Puck itself renders
// URLs with the ATS source id. A trailing `/apply` segment is tolerated.
func parseCareerpuckURL(rawURL string) (board, jobID string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", "", false
	}
	if strings.ToLower(parsed.Host) != "app.careerpuck.com" {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 4 || parts[0] != "job-board" || parts[2] != "job" {
		return "", "", false
	}
	if parts[1] == "" || parts[3] == "" {
		return "", "", false
	}
	return parts[1], parts[3], true
}
