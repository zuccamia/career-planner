package ats

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Workable fetches postings from `apply.workable.com/{tenant}/j/{code}` URLs
// via the tenant's public markdown endpoint (`.md`), which Workable ships
// alongside its `llms.txt`. Bypasses the cookie banner in the HTML shell.
type Workable struct {
	client *http.Client
}

func NewWorkable() *Workable {
	return &Workable{client: safeClient()}
}

func (*Workable) Name() string { return "workable" }

func (*Workable) Supports(rawURL string) bool {
	_, _, ok := parseWorkableURL(rawURL)
	return ok
}

func (w *Workable) Fetch(ctx context.Context, rawURL string) (Posting, error) {
	tenant, code, ok := parseWorkableURL(rawURL)
	if !ok {
		return Posting{}, fmt.Errorf("not a recognized workable url: %s", rawURL)
	}
	mdURL := fmt.Sprintf("https://apply.workable.com/%s/jobs/view/%s.md",
		url.PathEscape(tenant), url.PathEscape(code))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mdURL, nil)
	if err != nil {
		return Posting{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")
	req.Header.Set("Accept", "text/markdown, text/plain")
	body, err := fetchPostingBody(w.client, req, "workable", 1<<20)
	if err != nil {
		return Posting{}, err
	}
	return parseWorkableMarkdown(string(body), rawURL)
}

var (
	workableURLPathRE = regexp.MustCompile(`^/([^/]+)/j/([^/]+)`)
	// Workable markdown ships a stable structure: `# Title`, one blockquote
	// line with `Company · Location · Contract · Posted YYYY-MM-DD`, then
	// zero or more `**Field:** value` bold lines, then `## Description`.
	workableTitleRE      = regexp.MustCompile(`(?m)^#\s+(.+?)\s*$`)
	workableBlockquoteRE = regexp.MustCompile(`(?m)^>\s+(.+?)\s*$`)
	workableFieldRE      = regexp.MustCompile(`(?m)^\*\*([^*]+):\*\*\s+(.+?)\s*$`)
	workableDescRE       = regexp.MustCompile(`(?ms)^##\s+Description\s*$\s*(.+)$`)
	workablePostedRE     = regexp.MustCompile(`^Posted\s+(\d{4}-\d{2}-\d{2})`)
)

// workableContractTypes are the values Workable emits in the blockquote's
// contract-type column. Anything not in this set falls back to Location.
var workableContractTypes = map[string]struct{}{
	"Contract":   {},
	"Full-time":  {},
	"Part-time":  {},
	"Full time":  {},
	"Part time":  {},
	"Intern":     {},
	"Internship": {},
	"Temporary":  {},
	"Freelance":  {},
}

// parseWorkableURL extracts (tenant, code) from a Workable posting URL:
//   - https://apply.workable.com/{tenant}/j/{code}[/[apply/]]
func parseWorkableURL(rawURL string) (tenant, code string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", "", false
	}
	if strings.ToLower(parsed.Host) != "apply.workable.com" {
		return "", "", false
	}
	m := workableURLPathRE.FindStringSubmatch(parsed.Path)
	if len(m) != 3 {
		return "", "", false
	}
	return m[1], m[2], true
}

func parseWorkableMarkdown(md, applyURL string) (Posting, error) {
	p := Posting{Provider: "workable", ApplyURL: applyURL}

	if m := workableTitleRE.FindStringSubmatch(md); len(m) == 2 {
		p.Title = strings.TrimSpace(m[1])
	}
	if p.Title == "" {
		return Posting{}, fmt.Errorf("workable posting missing title")
	}

	if m := workableBlockquoteRE.FindStringSubmatch(md); len(m) == 2 {
		parts := strings.Split(m[1], "·")
		for i, s := range parts {
			parts[i] = strings.TrimSpace(s)
		}
		if len(parts) > 0 {
			p.Company = parts[0]
		}
		var locParts []string
		for _, part := range parts[1:] {
			if m := workablePostedRE.FindStringSubmatch(part); len(m) == 2 {
				if t, err := time.Parse("2006-01-02", m[1]); err == nil {
					p.PostedAt = t.UTC()
				}
				continue
			}
			if _, isContract := workableContractTypes[part]; isContract {
				p.EmploymentType = part
				continue
			}
			locParts = append(locParts, part)
		}
		p.Location = strings.Join(locParts, ", ")
	}

	// Prepend Remote/Hybrid to the location field if the workplace bold-line
	// signals it. Keeps the geographic hint intact so the ranker sees both.
	for _, m := range workableFieldRE.FindAllStringSubmatch(md, -1) {
		if strings.EqualFold(strings.TrimSpace(m[1]), "workplace") {
			switch strings.ToLower(strings.TrimSpace(m[2])) {
			case "remote":
				if p.Location == "" {
					p.Location = "Remote"
				} else {
					p.Location = "Remote — " + p.Location
				}
			case "hybrid":
				if p.Location == "" {
					p.Location = "Hybrid"
				} else {
					p.Location = "Hybrid — " + p.Location
				}
			}
		}
	}

	if m := workableDescRE.FindStringSubmatch(md); len(m) == 2 {
		p.DescriptionText = strings.TrimSpace(m[1])
	} else {
		p.DescriptionText = strings.TrimSpace(md)
	}
	if p.DescriptionText == "" {
		return Posting{}, fmt.Errorf("workable posting contained no description")
	}
	return p, nil
}
