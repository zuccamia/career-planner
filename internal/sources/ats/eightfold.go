package ats

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Eightfold fetches postings from Eightfold-hosted tenant sites
// (`{tenant}.eightfold.ai`) via their public position API. The public HTML
// pages are SPA shells with no server-rendered job data, so the API is the
// only reliable source of title/description.
type Eightfold struct {
	client *http.Client
}

func NewEightfold() *Eightfold {
	return &Eightfold{client: safeClient()}
}

func (*Eightfold) Name() string { return "eightfold" }

func (*Eightfold) Supports(rawURL string) bool {
	_, _, _, ok := parseEightfoldURL(rawURL)
	return ok
}

func (e *Eightfold) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	tenant, jobID, domain, ok := parseEightfoldURL(rawURL)
	if !ok {
		return Posting{}, fmt.Errorf("not a recognized eightfold url: %s", rawURL)
	}

	apiURL := fmt.Sprintf("https://%s.eightfold.ai/api/apply/v2/jobs/%s", tenant, url.PathEscape(jobID))
	if domain != "" {
		apiURL += "?domain=" + url.QueryEscape(domain)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return Posting{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")
	req.Header.Set("Accept", "application/json")

	body, err := fetchPostingBody(e.client, req, "eightfold", 1<<20)
	if err != nil {
		return Posting{}, err
	}

	var raw eightfoldJob
	if err := json.Unmarshal(body, &raw); err != nil {
		return Posting{}, fmt.Errorf("eightfold decode: %w", err)
	}
	if strings.TrimSpace(raw.Name) == "" {
		return Posting{}, fmt.Errorf("eightfold posting missing name")
	}

	description := htmlToText(html.UnescapeString(raw.JobDescription))
	if description == "" {
		description = htmlToText(html.UnescapeString(eightfoldCustomJD(raw.CustomJD)))
	}
	if description == "" {
		return Posting{}, fmt.Errorf("eightfold posting contained no description")
	}

	applyURL := strings.TrimSpace(raw.CanonicalPositionURL)
	if applyURL == "" {
		applyURL = rawURL
	}

	return Posting{
		Provider:        "eightfold",
		Title:           strings.TrimSpace(raw.Name),
		Company:         PrettifySlug(tenant),
		Location:        strings.Join(raw.Locations, "; "),
		ApplyURL:        applyURL,
		DescriptionText: description,
		EmploymentType:  strings.TrimSpace(raw.Type),
		PostedAt:        eightfoldPostedAt(raw.TCreate),
	}, nil
}

// eightfoldJob mirrors the fields we consume from the /api/apply/v2/jobs
// response. Kept minimal — additional fields (stars, medallionProgram, etc.)
// are ignored. CustomJD is json.RawMessage because some tenants return an
// object there instead of a string; we treat non-string shapes as absent.
type eightfoldJob struct {
	Name                 string          `json:"name"`
	PostingName          string          `json:"posting_name"`
	Location             string          `json:"location"`
	Locations            []string        `json:"locations"`
	Department           string          `json:"department"`
	BusinessUnit         string          `json:"business_unit"`
	Type                 string          `json:"type"`
	JobDescription       string          `json:"job_description"`
	CustomJD             json.RawMessage `json:"custom_JD"`
	CanonicalPositionURL string          `json:"canonicalPositionUrl"`
	TCreate              int64           `json:"t_create"`
}

// eightfoldCustomJD tries to decode custom_JD as a string, ignoring non-string
// shapes. Callers use it as a fallback when job_description is empty.
func eightfoldCustomJD(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// eightfoldPostedAt turns a Unix seconds timestamp into a UTC time; zero when
// missing/invalid.
func eightfoldPostedAt(ts int64) time.Time {
	if ts <= 0 {
		return time.Time{}
	}
	return time.Unix(ts, 0).UTC()
}

// eightfoldURLPathRE matches `/careers/job/<numeric-id>[-<slug>...]`.
var eightfoldURLPathRE = regexp.MustCompile(`^/careers/job/(\d+)`)

// parseEightfoldURL extracts (tenant, jobID, domain) from an Eightfold posting URL:
//   - https://{tenant}.eightfold.ai/careers/job/{jobID}-{slug}?domain={domain}
//
// domain may be empty; the API returns global data when omitted.
func parseEightfoldURL(rawURL string) (tenant, jobID, domain string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", "", "", false
	}
	host := strings.ToLower(parsed.Host)
	if !strings.HasSuffix(host, ".eightfold.ai") {
		return "", "", "", false
	}
	tenant = strings.TrimSuffix(host, ".eightfold.ai")
	if tenant == "" {
		return "", "", "", false
	}
	m := eightfoldURLPathRE.FindStringSubmatch(parsed.Path)
	if len(m) != 2 {
		return "", "", "", false
	}
	return tenant, m[1], parsed.Query().Get("domain"), true
}
