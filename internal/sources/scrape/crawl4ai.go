package scrape

// Crawl4AI docker server client. Endpoints: docs.crawl4ai.com/core/self-hosting
// (v0.9.x, mid-2026). Uses POST /md for scrape and POST /html + client-side
// link extraction to synthesize Map (Crawl4AI has no native map endpoint).

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type crawl4aiClient struct {
	*httpBase
}

func (c *crawl4aiClient) Provider() string { return ProviderCrawl4AI }

type crawl4aiMDReq struct {
	URL string `json:"url"`
}

type crawl4aiMDResp struct {
	Success  bool           `json:"success"`
	URL      string         `json:"url"`
	Markdown string         `json:"markdown"`
	Metadata map[string]any `json:"metadata"`
	Error    string         `json:"error"`
}

func (c *crawl4aiClient) Scrape(ctx context.Context, u string, _ ScrapeOptions) (*ScrapeResult, error) {
	var resp crawl4aiMDResp
	if err := c.postJSON(ctx, "/md", crawl4aiMDReq{URL: u}, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("crawl4ai md: %s", resp.Error)}
	}
	return &ScrapeResult{
		URL:       u,
		Markdown:  resp.Markdown,
		Metadata:  resp.Metadata,
		Provider: ProviderCrawl4AI,
		FetchedAt: time.Now().UTC(),
	}, nil
}

type crawl4aiHTMLReq struct {
	URL string `json:"url"`
}

type crawl4aiHTMLResp struct {
	Success bool   `json:"success"`
	URL     string `json:"url"`
	HTML    string `json:"html"`
	Error   string `json:"error"`
}

var hrefRE = regexp.MustCompile(`(?i)href\s*=\s*["']([^"']+)["']`)

func (c *crawl4aiClient) Map(ctx context.Context, u string, _ ScrapeOptions) (*MapResult, error) {
	var resp crawl4aiHTMLResp
	if err := c.postJSON(ctx, "/html", crawl4aiHTMLReq{URL: u}, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("crawl4ai html: %s", resp.Error)}
	}

	base, err := url.Parse(u)
	if err != nil {
		return nil, &Error{Message: fmt.Sprintf("parse base url: %v", err)}
	}

	seen := make(map[string]struct{})
	urls := make([]string, 0, 32)
	for _, m := range hrefRE.FindAllStringSubmatch(resp.HTML, -1) {
		raw := strings.TrimSpace(m[1])
		if raw == "" || strings.HasPrefix(raw, "#") || strings.HasPrefix(raw, "javascript:") ||
			strings.HasPrefix(raw, "mailto:") || strings.HasPrefix(raw, "tel:") {
			continue
		}
		abs, err := base.Parse(raw)
		if err != nil {
			continue
		}
		abs.Fragment = ""
		s := abs.String()
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		urls = append(urls, s)
	}

	return &MapResult{
		Domain:    u,
		URLs:      urls,
		Provider: ProviderCrawl4AI,
		FetchedAt: time.Now().UTC(),
	}, nil
}
