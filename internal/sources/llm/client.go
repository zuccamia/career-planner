package llm

// Shared LLM client. GenerateJSON dispatches to a per-provider generator
// (Anthropic Messages API, OpenAI-compatible chat completions) based on
// config, then decodes the fenced/JSON response.

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

// ---- client ----

// Prompt contains the system and user instructions sent to the LLM provider.
// Persona is optional and only populated for flows whose system template has
// a leading `%s` slot for a caller-provided persona (tailor/ranker today).
// Other flows leave it empty.
type Prompt struct {
	System  string
	User    string
	Persona string
}

// Client generates structured JSON from prompts.
type Client interface {
	GenerateJSON(ctx context.Context, prompt Prompt, out any) error
}

// ChatMessage / ChatTool / ChatToolCall mirror the OpenAI chat schema so
// the browser tool loop can round-trip messages without transformation.
type ChatMessage struct {
	Role       string         `json:"role"`
	Content    string         `json:"content,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	ToolCalls  []ChatToolCall `json:"tool_calls,omitempty"`
}

type ChatTool struct {
	Type     string           `json:"type"`
	Function ChatToolFunction `json:"function"`
}

type ChatToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// Arguments stays a raw JSON string per OpenAI convention.
type ChatToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type,omitempty"`
	Function ChatToolCallFunc `json:"function"`
}

type ChatToolCallFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ChatTurnRequest struct {
	Messages   []ChatMessage `json:"messages"`
	Tools      []ChatTool    `json:"tools,omitempty"`
	ToolChoice any           `json:"tool_choice,omitempty"`
}

// Exactly one of Content / ToolCalls is populated per turn.
type ChatTurnResponse struct {
	Content   string         `json:"content"`
	ToolCalls []ChatToolCall `json:"tool_calls,omitempty"`
}

// Implemented by *HTTPClient for OpenAI-compatible. Other providers return
// an APIError where IsToolSupportError is true so callers can fall back.
type ChatTurner interface {
	ChatTurn(ctx context.Context, req ChatTurnRequest) (ChatTurnResponse, error)
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
	return DecodeJSONResponse(raw, out)
}

// DecodeJSONResponse strips markdown fences from a raw model response and
// unmarshals it into out. Exposed so the BYOK /parse/:name endpoint can
// apply the exact same fence-stripping the server-side path does — keeping
// the sanitized shape identical whether the LLM call went through the
// server's key or the user's browser.
func DecodeJSONResponse(raw string, out any) error {
	if out == nil {
		return &Error{Message: "output target must not be nil"}
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

// ---- anthropic ----

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

// ---- openai-compatible ----

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
	Message openAICompatibleChoiceMessage `json:"message"`
}

type openAICompatibleChoiceMessage struct {
	Role      string         `json:"role"`
	Content   string         `json:"content"`
	ToolCalls []ChatToolCall `json:"tool_calls,omitempty"`
}

// ---- chat/tool-loop turn ----

// Anthropic returns an APIError that trips IsToolSupportError so callers
// can fall back cleanly.
func (c *HTTPClient) ChatTurn(ctx context.Context, req ChatTurnRequest) (ChatTurnResponse, error) {
	switch c.config.Provider {
	case ProviderOpenAICompatible:
		return c.chatTurnOpenAICompatible(ctx, req)
	case ProviderAnthropic:
		return ChatTurnResponse{}, &APIError{Message: "tools is not supported by this provider (anthropic)"}
	default:
		return ChatTurnResponse{}, &ConfigError{Message: fmt.Sprintf("unsupported provider %q", c.config.Provider)}
	}
}

// response_format is omitted — tool-emitting models don't reliably accept
// json_object mode and tools together.
type openAICompatibleChatTurnRequest struct {
	Model      string        `json:"model"`
	Messages   []ChatMessage `json:"messages"`
	Tools      []ChatTool    `json:"tools,omitempty"`
	ToolChoice any           `json:"tool_choice,omitempty"`
}

func (c *HTTPClient) chatTurnOpenAICompatible(ctx context.Context, req ChatTurnRequest) (ChatTurnResponse, error) {
	body := openAICompatibleChatTurnRequest{
		Model:      c.config.Model,
		Messages:   req.Messages,
		Tools:      req.Tools,
		ToolChoice: req.ToolChoice,
	}
	headers := map[string]string{"content-type": "application/json"}
	if c.config.APIKey != "" {
		headers["authorization"] = "Bearer " + c.config.APIKey
	}
	var response openAICompatibleResponse
	if err := c.doJSONRequest(ctx, http.MethodPost, c.config.BaseURL+"/chat/completions", body, headers, &response); err != nil {
		return ChatTurnResponse{}, err
	}
	if len(response.Choices) == 0 {
		return ChatTurnResponse{}, &APIError{Message: "openai-compatible response contained no choices"}
	}
	msg := response.Choices[0].Message
	return ChatTurnResponse{Content: msg.Content, ToolCalls: msg.ToolCalls}, nil
}
