package llm

// Implements OpenAI-compatible JSON generation for the shared LLM client.

import (
	"context"
	"net/http"
)

// generateOpenAICompatibleJSON requests a JSON object response from an OpenAI-compatible chat completions API.
func (c *HTTPClient) generateOpenAICompatibleJSON(ctx context.Context, prompt Prompt) (string, error) {
	body := openAICompatibleRequest{
		Model: c.config.Model,
		Messages: []openAICompatibleMessage{
			{Role: "system", Content: prompt.System},
			{Role: "user", Content: prompt.User},
		},
		ResponseFormat: &openAICompatibleResponseFormat{Type: "json_object"},
	}

	headers := map[string]string{"content-type": "application/json"}
	if c.config.APIKey != "" {
		headers["authorization"] = "Bearer " + c.config.APIKey
	}

	var response openAICompatibleResponse
	if err := c.doJSONRequest(ctx, http.MethodPost, c.config.BaseURL+"/chat/completions", body, headers, &response); err != nil {
		return "", err
	}
	if len(response.Choices) == 0 {
		return "", &APIError{Message: "openai-compatible response contained no choices"}
	}
	return response.Choices[0].Message.Content, nil
}

type openAICompatibleRequest struct {
	Model          string                          `json:"model"`
	Messages       []openAICompatibleMessage       `json:"messages"`
	ResponseFormat *openAICompatibleResponseFormat `json:"response_format,omitempty"`
}

type openAICompatibleMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAICompatibleResponseFormat struct {
	Type string `json:"type"`
}

type openAICompatibleResponse struct {
	Choices []openAICompatibleChoice `json:"choices"`
}

type openAICompatibleChoice struct {
	Message openAICompatibleMessage `json:"message"`
}
