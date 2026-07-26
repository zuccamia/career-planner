package llm

// Implements Anthropic-specific JSON generation for the shared LLM client.

import (
	"context"
	"net/http"
	"strings"
)

const anthropicAPIVersion = "2023-06-01"

// generateAnthropicJSON requests a JSON-shaped response from the Anthropic Messages API.
func (c *HTTPClient) generateAnthropicJSON(ctx context.Context, prompt Prompt) (string, error) {
	body := anthropicRequest{
		Model:     c.config.Model,
		MaxTokens: 1200,
		System:    prompt.System,
		Messages:  []anthropicMessage{{Role: "user", Content: prompt.User}},
	}

	var response anthropicResponse
	if err := c.doJSONRequest(ctx, http.MethodPost, c.config.BaseURL+"/messages", body, map[string]string{
		"content-type":      "application/json",
		"x-api-key":         c.config.APIKey,
		"anthropic-version": anthropicAPIVersion,
	}, &response); err != nil {
		return "", err
	}

	var parts []string
	for _, block := range response.Content {
		if block.Type == "text" {
			parts = append(parts, block.Text)
		}
	}
	if len(parts) == 0 {
		return "", &APIError{Message: "anthropic response contained no text content"}
	}
	return strings.Join(parts, "\n"), nil
}

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicResponse struct {
	Content []anthropicContentBlock `json:"content"`
}

type anthropicContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}
