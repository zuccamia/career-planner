package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---- extractJSON ----

func TestExtractJSONStripsMarkdownFence(t *testing.T) {
	in := "```json\n{\"a\":1}\n```"
	if got := extractJSON(in); got != `{"a":1}` {
		t.Errorf("extractJSON(fenced) = %q", got)
	}
}

func TestExtractJSONStripsBareFence(t *testing.T) {
	if got := extractJSON("```\n{\"a\":1}\n```"); got != `{"a":1}` {
		t.Errorf("extractJSON(bare fence) = %q", got)
	}
}

func TestExtractJSONSlicesToOutermostBraces(t *testing.T) {
	in := "here is some prose {\"a\":1} trailing text"
	if got := extractJSON(in); got != `{"a":1}` {
		t.Errorf("extractJSON(prose) = %q", got)
	}
}

func TestExtractJSONNoBracesReturnsTrimmed(t *testing.T) {
	if got := extractJSON("  hello  "); got != "hello" {
		t.Errorf("extractJSON(plain) = %q", got)
	}
}

// ---- GenerateJSON e2e ----

func newTestHTTPClient(baseURL, provider, apiKey, model string) *HTTPClient {
	c := NewClient(Config{Provider: provider, BaseURL: baseURL, APIKey: apiKey, Model: model})
	return c
}

func TestGenerateJSONNilOutReturnsError(t *testing.T) {
	c := newTestHTTPClient("http://example", ProviderAnthropic, "sk", "claude")
	if err := c.GenerateJSON(context.Background(), Prompt{User: "hi"}, nil); err == nil {
		t.Fatal("expected error for nil out")
	}
}

func TestGenerateJSONUnsupportedProvider(t *testing.T) {
	c := newTestHTTPClient("http://example", "cohere", "sk", "x")
	var out map[string]any
	err := c.GenerateJSON(context.Background(), Prompt{User: "hi"}, &out)
	if err == nil {
		t.Fatal("expected error for unsupported provider")
	}
	if _, ok := err.(*ConfigError); !ok {
		t.Errorf("err type = %T, want *ConfigError", err)
	}
}

func TestGenerateJSONAnthropicSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/messages" {
			t.Errorf("path = %q, want /messages", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "sk-test" {
			t.Errorf("missing x-api-key header")
		}
		if r.Header.Get("anthropic-version") == "" {
			t.Errorf("missing anthropic-version header")
		}
		bodyBytes, _ := io.ReadAll(r.Body)
		var req anthropicRequest
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			t.Fatalf("bad request body: %v", err)
		}
		if req.System != "sys" || len(req.Messages) != 1 || req.Messages[0].Content != "user" {
			t.Errorf("unexpected request body: %+v", req)
		}
		_ = json.NewEncoder(w).Encode(anthropicResponse{
			Content: []anthropicContentBlock{{Type: "text", Text: "```json\n{\"answer\":42}\n```"}},
		})
	}))
	defer srv.Close()

	c := newTestHTTPClient(srv.URL, ProviderAnthropic, "sk-test", "claude")
	var out struct{ Answer int }
	if err := c.GenerateJSON(context.Background(), Prompt{System: "sys", User: "user"}, &out); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Answer != 42 {
		t.Errorf("Answer = %d, want 42", out.Answer)
	}
}

func TestGenerateJSONAnthropicEmptyContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(anthropicResponse{})
	}))
	defer srv.Close()
	c := newTestHTTPClient(srv.URL, ProviderAnthropic, "sk", "claude")
	var out map[string]any
	err := c.GenerateJSON(context.Background(), Prompt{User: "u"}, &out)
	if err == nil {
		t.Fatal("expected error for empty content")
	}
	if !strings.Contains(err.Error(), "no text content") {
		t.Errorf("err = %v, want 'no text content' signal", err)
	}
}

func TestGenerateJSONAnthropicNon2xxSurfacesAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad model"}`))
	}))
	defer srv.Close()
	c := newTestHTTPClient(srv.URL, ProviderAnthropic, "sk", "claude")
	var out map[string]any
	err := c.GenerateJSON(context.Background(), Prompt{User: "u"}, &out)
	if err == nil {
		t.Fatal("expected error for 400 response")
	}
	if _, ok := err.(*APIError); !ok {
		t.Errorf("err type = %T, want *APIError", err)
	}
}

func TestGenerateJSONOpenAICompatibleSuccessAndAuthHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %q, want /chat/completions", r.URL.Path)
		}
		if r.Header.Get("authorization") != "Bearer sk-test" {
			t.Errorf("authorization header = %q", r.Header.Get("authorization"))
		}
		_ = json.NewEncoder(w).Encode(openAICompatibleResponse{
			Choices: []openAICompatibleChoice{{Message: openAICompatibleMessage{Content: `{"ok":true}`}}},
		})
	}))
	defer srv.Close()
	c := newTestHTTPClient(srv.URL, ProviderOpenAICompatible, "sk-test", "gpt-4o")
	var out struct{ Ok bool }
	if err := c.GenerateJSON(context.Background(), Prompt{User: "u"}, &out); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !out.Ok {
		t.Error("Ok = false, want true")
	}
}

func TestGenerateJSONOpenAICompatibleNoAuthHeaderWhenKeyEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "" {
			t.Errorf("authorization header should be absent when api key empty; got %q", r.Header.Get("authorization"))
		}
		_ = json.NewEncoder(w).Encode(openAICompatibleResponse{
			Choices: []openAICompatibleChoice{{Message: openAICompatibleMessage{Content: `{"ok":true}`}}},
		})
	}))
	defer srv.Close()
	c := newTestHTTPClient(srv.URL, ProviderOpenAICompatible, "", "local-model")
	var out map[string]any
	if err := c.GenerateJSON(context.Background(), Prompt{User: "u"}, &out); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGenerateJSONOpenAICompatibleEmptyChoices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(openAICompatibleResponse{})
	}))
	defer srv.Close()
	c := newTestHTTPClient(srv.URL, ProviderOpenAICompatible, "", "m")
	var out map[string]any
	err := c.GenerateJSON(context.Background(), Prompt{User: "u"}, &out)
	if err == nil {
		t.Fatal("expected error for empty choices")
	}
}

func TestGenerateJSONMalformedInnerJSONReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(openAICompatibleResponse{
			Choices: []openAICompatibleChoice{{Message: openAICompatibleMessage{Content: `not-json`}}},
		})
	}))
	defer srv.Close()
	c := newTestHTTPClient(srv.URL, ProviderOpenAICompatible, "", "m")
	var out map[string]any
	err := c.GenerateJSON(context.Background(), Prompt{User: "u"}, &out)
	if err == nil {
		t.Fatal("expected error for non-JSON inner content")
	}
	if _, ok := err.(*APIError); !ok {
		t.Errorf("err type = %T, want *APIError", err)
	}
}
