package applications

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

func fetchJobPostingText(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "career-planner/1.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request job posting: %w", err)
	}
	defer resp.Body.Close()
	if loginRedirectURL(resp.Request.URL.String()) {
		return "", fmt.Errorf("job posting requires sign-in or access protection; paste the raw description instead")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", fmt.Errorf("read response body: %w", err)
	}
	text := extractStructuredJobPostingText(string(body))
	if text == "" {
		text = htmlToText(string(body))
	}
	if text == "" {
		return "", fmt.Errorf("no readable job description text found")
	}
	return text, nil
}

func loginRedirectURL(url string) bool {
	url = strings.ToLower(strings.TrimSpace(url))
	return strings.Contains(url, "/login") || strings.Contains(url, "/access") || strings.Contains(url, "signin") || strings.Contains(url, "sign-in")
}

var (
	ldJSONScriptRE = regexp.MustCompile(`(?is)<script[^>]*type=["']application/ld\+json["'][^>]*>(.*?)</script>`)
	scriptRE = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	styleRE  = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	commentRE = regexp.MustCompile(`(?s)<!--.*?-->`)
	boilerplateSectionRE = regexp.MustCompile(`(?is)<(nav|footer|aside|noscript)[^>]*>.*?</(nav|footer|aside|noscript)>`)
	cookieBannerRE = regexp.MustCompile(`(?is)<[^>]*(cookie|consent|gdpr)[^>]*>.*?</[^>]+>`)
	lineBreakRE = regexp.MustCompile(`(?i)<br\s*/?>`)
	blockCloseRE = regexp.MustCompile(`(?i)</(p|div|section|article|main|header|h1|h2|h3|h4|h5|h6|li|ul|ol|table|tr)>`)
	listItemOpenRE = regexp.MustCompile(`(?i)<li[^>]*>`)
	tagRE    = regexp.MustCompile(`(?s)<[^>]+>`)
	newlineSpaceRE = regexp.MustCompile(`[ \t\f\v\r]+\n`)
	multiNewlineRE = regexp.MustCompile(`\n{3,}`)
	spaceRE  = regexp.MustCompile(`[ \t\f\v]+`)
)

type ldJobPosting struct {
	Type        string `json:"@type"`
	Description string `json:"description"`
	Title       string `json:"title"`
}

func extractStructuredJobPostingText(input string) string {
	matches := ldJSONScriptRE.FindAllStringSubmatch(input, -1)
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		text := extractLDJSONDescription(match[1])
		if text != "" {
			return text
		}
	}
	return ""
}

func extractLDJSONDescription(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var single ldJobPosting
	if err := json.Unmarshal([]byte(raw), &single); err == nil {
		if strings.EqualFold(single.Type, "JobPosting") {
			return htmlToText(single.Description)
		}
	}
	var many []ldJobPosting
	if err := json.Unmarshal([]byte(raw), &many); err == nil {
		for _, item := range many {
			if strings.EqualFold(item.Type, "JobPosting") {
				if text := htmlToText(item.Description); text != "" {
					return text
				}
			}
		}
	}
	return ""
}

func htmlToText(input string) string {
	cleaned := scriptRE.ReplaceAllString(input, " ")
	cleaned = styleRE.ReplaceAllString(cleaned, " ")
	cleaned = commentRE.ReplaceAllString(cleaned, " ")
	cleaned = boilerplateSectionRE.ReplaceAllString(cleaned, " ")
	cleaned = cookieBannerRE.ReplaceAllString(cleaned, " ")
	cleaned = lineBreakRE.ReplaceAllString(cleaned, "\n")
	cleaned = blockCloseRE.ReplaceAllString(cleaned, "$0\n")
	cleaned = listItemOpenRE.ReplaceAllString(cleaned, "\n- ")
	cleaned = tagRE.ReplaceAllString(cleaned, " ")
	cleaned = html.UnescapeString(cleaned)
	cleaned = htmlEntityReplacer.Replace(cleaned)
	cleaned = strings.ReplaceAll(cleaned, "\u00a0", " ")
	cleaned = newlineSpaceRE.ReplaceAllString(cleaned, "\n")
	cleaned = spaceRE.ReplaceAllString(cleaned, " ")
	cleaned = strings.ReplaceAll(cleaned, " \n", "\n")
	cleaned = strings.ReplaceAll(cleaned, "\n ", "\n")
	cleaned = multiNewlineRE.ReplaceAllString(cleaned, "\n\n")
	cleaned = spaceRE.ReplaceAllString(cleaned, " ")
	return strings.TrimSpace(cleaned)
}

var htmlEntityReplacer = strings.NewReplacer(
	"&nbsp;", " ",
	"&amp;", "&",
	"&lt;", "<",
	"&gt;", ">",
	"&quot;", `"`,
	"&#39;", "'",
)