package scrape

// Firecrawl v1 API client. Docs: https://docs.firecrawl.dev/api-reference/
// This is a thin wrapper — we only use /v1/scrape and /v1/map.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type firecrawlClient struct {
	*httpBase
}

func (c *firecrawlClient) Backend() string { return BackendFirecrawl }

type firecrawlScrapeReq struct {
	URL             string   `json:"url"`
	Formats         []string `json:"formats,omitempty"`
	OnlyMainContent bool     `json:"onlyMainContent,omitempty"`
	WaitFor         int      `json:"waitFor,omitempty"`
}

type firecrawlScrapeResp struct {
	Success bool `json:"success"`
	Data    struct {
		Markdown string         `json:"markdown"`
		HTML     string         `json:"html"`
		Metadata map[string]any `json:"metadata"`
	} `json:"data"`
	Error string `json:"error"`
}

func (c *firecrawlClient) Scrape(ctx context.Context, url string, opts ScrapeOptions) (*ScrapeResult, error) {
	formats := opts.Formats
	if len(formats) == 0 {
		formats = []string{"markdown"}
	}
	body := firecrawlScrapeReq{
		URL:             url,
		Formats:         formats,
		OnlyMainContent: opts.OnlyMainContent,
		WaitFor:         opts.WaitFor,
	}
	var resp firecrawlScrapeResp
	if err := c.postJSON(ctx, "/v1/scrape", body, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("firecrawl scrape: %s", resp.Error)}
	}
	return &ScrapeResult{
		URL:       url,
		Markdown:  resp.Data.Markdown,
		HTML:      resp.Data.HTML,
		Metadata:  resp.Data.Metadata,
		Backend:   BackendFirecrawl,
		FetchedAt: time.Now().UTC(),
	}, nil
}

type firecrawlMapReq struct {
	URL string `json:"url"`
}

type firecrawlMapResp struct {
	Success bool     `json:"success"`
	Links   []string `json:"links"`
	Error   string   `json:"error"`
}

func (c *firecrawlClient) Map(ctx context.Context, url string, opts ScrapeOptions) (*MapResult, error) {
	body := firecrawlMapReq{URL: url}
	var resp firecrawlMapResp
	if err := c.postJSON(ctx, "/v1/map", body, &resp); err != nil {
		return nil, err
	}
	if !resp.Success && resp.Error != "" {
		return nil, &APIError{Message: fmt.Sprintf("firecrawl map: %s", resp.Error)}
	}
	return &MapResult{
		Domain:    url,
		URLs:      resp.Links,
		Backend:   BackendFirecrawl,
		FetchedAt: time.Now().UTC(),
	}, nil
}

func (b *httpBase) postJSON(ctx context.Context, path string, requestBody any, out any) error {
	payload, err := json.Marshal(requestBody)
	if err != nil {
		return &Error{Message: fmt.Sprintf("marshal request: %v", err)}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return &Error{Message: fmt.Sprintf("build request: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	if b.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+b.apiKey)
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("request failed: %v", err)}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("read response: %v", err)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{
			Status:  resp.StatusCode,
			Message: fmt.Sprintf("scraper API returned %s: %s", resp.Status, strings.TrimSpace(string(body))),
		}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &APIError{Message: fmt.Sprintf("decode response: %v", err)}
	}
	return nil
}
