package ats

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const ashbyPageBase = "https://jobs.ashbyhq.com"

// Ashby fetches postings by scraping the JSON-LD JobPosting block embedded in
// the single-posting HTML page. This is ~16× smaller than Ashby's board API
// for a single-role paste and scales flat with company size.
type Ashby struct {
	client   *http.Client
	pageBase string // override for tests
}

// NewAshby returns an Ashby provider with a sensible HTTP client.
func NewAshby() *Ashby {
	return &Ashby{
		client:   &http.Client{Timeout: 15 * time.Second},
		pageBase: ashbyPageBase,
	}
}

func (*Ashby) Name() string { return "ashby" }

func (*Ashby) Supports(rawURL string) bool {
	_, _, ok := parseAshbyURL(rawURL)
	return ok
}

func (a *Ashby) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	org, id, ok := parseAshbyURL(rawURL)
	if !ok {
		return Posting{}, fmt.Errorf("not a recognized ashby url: %s", rawURL)
	}

	base := a.pageBase
	if base == "" {
		base = ashbyPageBase
	}
	pageURL := fmt.Sprintf("%s/%s/%s", strings.TrimRight(base, "/"), url.PathEscape(org), url.PathEscape(id))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return Posting{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")

	client := a.client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Posting{}, fmt.Errorf("request ashby page: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Posting{}, fmt.Errorf("ashby posting not found: %s", rawURL)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Posting{}, fmt.Errorf("unexpected status %d from ashby page", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Posting{}, fmt.Errorf("read ashby page: %w", err)
	}

	jp, ok := findJobPostingJSONLD(string(body))
	if !ok {
		return Posting{}, fmt.Errorf("ashby page missing JobPosting JSON-LD")
	}

	description := htmlToText(html.UnescapeString(jp.Description))
	if description == "" {
		return Posting{}, fmt.Errorf("ashby posting contained no description")
	}

	return Posting{
		Provider:        "ashby",
		Title:           strings.TrimSpace(jp.Title),
		Company:         strings.TrimSpace(jp.HiringOrganization.Name),
		Location:        formatJobLocation(jp.JobLocation),
		Compensation:    formatSalary(jp.BaseSalary),
		ApplyURL:        rawURL,
		DescriptionText: description,
	}, nil
}

// parseAshbyURL extracts (organizationSlug, jobID) from an Ashby posting URL:
//   - https://jobs.ashbyhq.com/{org}/{id}
func parseAshbyURL(rawURL string) (org, id string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", "", false
	}
	if strings.ToLower(parsed.Host) != "jobs.ashbyhq.com" {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// schemaJobPosting mirrors the schema.org JobPosting subset we care about.
type schemaJobPosting struct {
	Type               string          `json:"@type"`
	Title              string          `json:"title"`
	Description        string          `json:"description"`
	EmploymentType     string          `json:"employmentType"`
	HiringOrganization struct {
		Name string `json:"name"`
	} `json:"hiringOrganization"`
	JobLocation json.RawMessage `json:"jobLocation"`
	BaseSalary  struct {
		Currency string `json:"currency"`
		Value    struct {
			MinValue float64 `json:"minValue"`
			MaxValue float64 `json:"maxValue"`
			UnitText string  `json:"unitText"`
		} `json:"value"`
	} `json:"baseSalary"`
}

// findJobPostingJSONLD scans HTML for <script type="application/ld+json"> blocks
// and returns the first one whose @type is "JobPosting".
func findJobPostingJSONLD(input string) (schemaJobPosting, bool) {
	matches := ldJSONScriptRE.FindAllStringSubmatch(input, -1)
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		raw := strings.TrimSpace(match[1])
		if raw == "" {
			continue
		}
		var single schemaJobPosting
		if err := json.Unmarshal([]byte(raw), &single); err == nil && strings.EqualFold(single.Type, "JobPosting") {
			return single, true
		}
		var many []schemaJobPosting
		if err := json.Unmarshal([]byte(raw), &many); err == nil {
			for _, item := range many {
				if strings.EqualFold(item.Type, "JobPosting") {
					return item, true
				}
			}
		}
	}
	return schemaJobPosting{}, false
}

// formatJobLocation parses schema.org jobLocation (Place with PostalAddress) or
// an array of such. Returns a human-readable string like "San Francisco, California".
func formatJobLocation(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		var many []schemaPlace
		if err := json.Unmarshal(raw, &many); err == nil && len(many) > 0 {
			return placeToString(many[0])
		}
		return ""
	}
	var single schemaPlace
	if err := json.Unmarshal(raw, &single); err == nil {
		return placeToString(single)
	}
	return ""
}

type schemaPlace struct {
	Name    string `json:"name"`
	Address struct {
		Locality string `json:"addressLocality"`
		Region   string `json:"addressRegion"`
		Country  string `json:"addressCountry"`
	} `json:"address"`
}

func placeToString(p schemaPlace) string {
	parts := []string{}
	for _, s := range []string{p.Address.Locality, p.Address.Region, p.Address.Country} {
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, ", ")
	}
	return strings.TrimSpace(p.Name)
}

func formatSalary(s struct {
	Currency string `json:"currency"`
	Value    struct {
		MinValue float64 `json:"minValue"`
		MaxValue float64 `json:"maxValue"`
		UnitText string  `json:"unitText"`
	} `json:"value"`
}) string {
	if s.Value.MinValue == 0 && s.Value.MaxValue == 0 {
		return ""
	}
	amount := ""
	switch {
	case s.Value.MinValue == s.Value.MaxValue:
		amount = trimFloat(s.Value.MinValue)
	default:
		amount = trimFloat(s.Value.MinValue) + "-" + trimFloat(s.Value.MaxValue)
	}
	out := amount
	if s.Currency != "" {
		out = s.Currency + " " + out
	}
	if s.Value.UnitText != "" {
		out += "/" + strings.ToLower(s.Value.UnitText)
	}
	return out
}

func trimFloat(f float64) string {
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	return fmt.Sprintf("%g", f)
}
