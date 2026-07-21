package llm

// Provides a shared LLM client for provider-backed structured JSON generation.

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

// Prompt contains the system and user instructions sent to the LLM provider.
type Prompt struct {
	System string
	User   string
}

// Client generates structured JSON from prompts.
type Client interface {
	GenerateJSON(ctx context.Context, prompt Prompt, out any) error
}

// HTTPClient calls a configured LLM provider over HTTP.
type HTTPClient struct {
	config     Config
	httpClient *http.Client
}

// NewClient constructs an HTTP-backed LLM client from provider configuration.
func NewClient(config Config) *HTTPClient {
	return &HTTPClient{
		config: config,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// GenerateJSON requests a JSON response and unmarshals it into the provided output value.
func (c *HTTPClient) GenerateJSON(ctx context.Context, prompt Prompt, out any) error {
	if out == nil {
		return &Error{Message: "output target must not be nil"}
	}

	var raw string
	var err error

	switch c.config.Provider {
	case ProviderAnthropic:
		raw, err = c.generateAnthropicJSON(ctx, prompt)
	case ProviderOpenAICompatible:
		raw, err = c.generateOpenAICompatibleJSON(ctx, prompt)
	default:
		return &ConfigError{Message: fmt.Sprintf("unsupported provider %q", c.config.Provider)}
	}
	if err != nil {
		return err
	}

	cleaned := extractJSON(raw)
	if err := json.Unmarshal([]byte(cleaned), out); err != nil {
		return &APIError{Message: fmt.Sprintf("decode JSON response: %v", err)}
	}
	return nil
}

// doJSONRequest marshals a request body, executes the HTTP call, and unmarshals the JSON response.
func (c *HTTPClient) doJSONRequest(ctx context.Context, method, url string, requestBody any, headers map[string]string, out any) error {
	payload, err := json.Marshal(requestBody)
	if err != nil {
		return &Error{Message: fmt.Sprintf("marshal request: %v", err)}
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(payload))
	if err != nil {
		return &Error{Message: fmt.Sprintf("build request: %v", err)}
	}
	for key, value := range headers {
		if value != "" {
			req.Header.Set(key, value)
		}
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("request failed: %v", err)}
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("read response: %v", err)}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Message: fmt.Sprintf("llm API returned %s: %s", resp.Status, strings.TrimSpace(string(bodyBytes)))}
	}

	if err := json.Unmarshal(bodyBytes, out); err != nil {
		return &APIError{Message: fmt.Sprintf("decode response body: %v", err)}
	}
	return nil
}

// extractJSON strips common markdown fences and returns the outermost JSON object from raw model output.
func extractJSON(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, "```json")
	trimmed = strings.TrimPrefix(trimmed, "```")
	trimmed = strings.TrimSuffix(trimmed, "```")
	trimmed = strings.TrimSpace(trimmed)

	start := strings.Index(trimmed, "{")
	end := strings.LastIndex(trimmed, "}")
	if start >= 0 && end >= start {
		return trimmed[start : end+1]
	}
	return trimmed
}
