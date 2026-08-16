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

// SmartRecruiters fetches postings from `jobs.smartrecruiters.com/{tenant}/…`
// URLs via the public jobs API. The public HTML page carries the same fields
// but the JSON endpoint is easier to parse and cheaper to fetch.
type SmartRecruiters struct {
	client *http.Client
}

func NewSmartRecruiters() *SmartRecruiters {
	return &SmartRecruiters{client: safeClient()}
}

func (*SmartRecruiters) Name() string { return "smartrecruiters" }

func (*SmartRecruiters) Supports(rawURL string) bool {
	_, _, ok := parseSmartRecruitersURL(rawURL)
	return ok
}

func (s *SmartRecruiters) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	tenant, postingID, ok := parseSmartRecruitersURL(rawURL)
	if !ok {
		return Posting{}, fmt.Errorf("not a recognized smartrecruiters url: %s", rawURL)
	}
	apiURL := fmt.Sprintf("https://api.smartrecruiters.com/v1/companies/%s/postings/%s",
		url.PathEscape(tenant), url.PathEscape(postingID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return Posting{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")
	req.Header.Set("Accept", "application/json")

	body, err := fetchPostingBody(s.client, req, "smartrecruiters", 1<<20)
	if err != nil {
		return Posting{}, err
	}

	var raw smartRecruitersJob
	if err := json.Unmarshal(body, &raw); err != nil {
		return Posting{}, fmt.Errorf("smartrecruiters decode: %w", err)
	}
	if strings.TrimSpace(raw.Name) == "" {
		return Posting{}, fmt.Errorf("smartrecruiters posting missing name")
	}

	// Join description sections in reading order; sections are optional and
	// vary per tenant, so skip empties without failing.
	var parts []string
	for _, sec := range []smartRecruitersSection{
		raw.JobAd.Sections.JobDescription,
		raw.JobAd.Sections.Qualifications,
		raw.JobAd.Sections.AdditionalInformation,
		raw.JobAd.Sections.CompanyDescription,
	} {
		if t := strings.TrimSpace(sec.Text); t != "" {
			if sec.Title != "" {
				parts = append(parts, "<h3>"+html.EscapeString(sec.Title)+"</h3>")
			}
			parts = append(parts, t)
		}
	}
	description := htmlToText(html.UnescapeString(strings.Join(parts, "\n")))
	if description == "" {
		return Posting{}, fmt.Errorf("smartrecruiters posting contained no description")
	}

	return Posting{
		Provider:        "smartrecruiters",
		Title:           strings.TrimSpace(raw.Name),
		Company:         strings.TrimSpace(raw.Company.Name),
		Location:        smartRecruitersLocation(raw.Location),
		ApplyURL:        strings.TrimSpace(raw.ApplyURL),
		DescriptionText: description,
		EmploymentType:  strings.TrimSpace(raw.TypeOfEmployment.Label),
		PostedAt:        smartRecruitersPostedAt(raw.ReleasedDate),
	}, nil
}

// smartRecruitersJob mirrors the fields we consume from the public jobs API.
type smartRecruitersJob struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	UUID  string `json:"uuid"`
	Company struct {
		Name       string `json:"name"`
		Identifier string `json:"identifier"`
	} `json:"company"`
	Location smartRecruitersLoc `json:"location"`
	JobAd    struct {
		Sections struct {
			JobDescription        smartRecruitersSection `json:"jobDescription"`
			Qualifications        smartRecruitersSection `json:"qualifications"`
			AdditionalInformation smartRecruitersSection `json:"additionalInformation"`
			CompanyDescription    smartRecruitersSection `json:"companyDescription"`
		} `json:"sections"`
	} `json:"jobAd"`
	ApplyURL     string `json:"applyUrl"`
	ReleasedDate string `json:"releasedDate"`
	TypeOfEmployment struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	} `json:"typeOfEmployment"`
}

type smartRecruitersLoc struct {
	City         string `json:"city"`
	Region       string `json:"region"`
	Country      string `json:"country"`
	Remote       bool   `json:"remote"`
	Hybrid       bool   `json:"hybrid"`
	FullLocation string `json:"fullLocation"`
}

type smartRecruitersSection struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

// smartRecruitersLocation formats the API's location object into a human
// string. fullLocation is often just ", " so we synthesize from city/region/
// country when it's empty, and prefix Remote/Hybrid tags.
func smartRecruitersLocation(loc smartRecruitersLoc) string {
	fields := []string{loc.City, loc.Region, strings.ToUpper(loc.Country)}
	var parts []string
	for _, f := range fields {
		if s := strings.TrimSpace(f); s != "" {
			parts = append(parts, s)
		}
	}
	base := strings.Join(parts, ", ")
	if base == "" {
		base = strings.Trim(loc.FullLocation, ", ")
	}
	switch {
	case loc.Remote:
		if base == "" {
			return "Remote"
		}
		return "Remote — " + base
	case loc.Hybrid:
		if base == "" {
			return "Hybrid"
		}
		return "Hybrid — " + base
	}
	return base
}

// smartRecruitersPostedAt parses the API's RFC3339-ish releasedDate.
func smartRecruitersPostedAt(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000+0000", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

// smartRecruitersURLPathRE matches `/{tenant}/{numeric-id}[-<slug>...]`.
var smartRecruitersURLPathRE = regexp.MustCompile(`^/([^/]+)/(\d+)`)

// parseSmartRecruitersURL extracts (tenant, postingID) from a SmartRecruiters
// posting URL:
//   - https://jobs.smartrecruiters.com/{tenant}/{postingID}-{slug}
func parseSmartRecruitersURL(rawURL string) (tenant, postingID string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", "", false
	}
	if strings.ToLower(parsed.Host) != "jobs.smartrecruiters.com" {
		return "", "", false
	}
	m := smartRecruitersURLPathRE.FindStringSubmatch(parsed.Path)
	if len(m) != 3 {
		return "", "", false
	}
	return m[1], m[2], true
}
