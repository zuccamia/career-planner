package llm

import (
	"testing"
)

// ---- isPlaceholderSecret ----

func TestIsPlaceholderSecret(t *testing.T) {
	cases := map[string]bool{
		"your_key_here":   true,
		"YOUR_KEY_HERE":   true,
		`"your_key_here"`: true,
		"'your_key_here'": true,
		"sk-real-key":     false,
		"":                false, // caller treats empty separately
	}
	for in, want := range cases {
		if got := isPlaceholderSecret(in); got != want {
			t.Errorf("isPlaceholderSecret(%q) = %v, want %v", in, got, want)
		}
	}
}

// ---- LoadConfig ----

func setEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoadConfigDefaultsToAnthropic(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "",
		"LLM_API_KEY":  "sk-test",
		"LLM_MODEL":    "claude-opus-4",
		"LLM_BASE_URL": "",
	})
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Provider != ProviderAnthropic {
		t.Errorf("Provider = %q, want anthropic default", cfg.Provider)
	}
	if cfg.BaseURL != AnthropicDefaultBaseURL {
		t.Errorf("BaseURL = %q, want anthropic default", cfg.BaseURL)
	}
}

func TestLoadConfigTrimsTrailingSlashOnBaseURL(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "openai-compatible",
		"LLM_API_KEY":  "sk-test",
		"LLM_MODEL":    "gpt-4o",
		"LLM_BASE_URL": "https://api.example.com/v1///",
	})
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BaseURL != "https://api.example.com/v1" {
		t.Errorf("BaseURL = %q, want trailing slashes trimmed", cfg.BaseURL)
	}
}

func TestLoadConfigRejectsUnsupportedProvider(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "cohere",
		"LLM_API_KEY":  "sk-test",
		"LLM_MODEL":    "x",
		"LLM_BASE_URL": "https://example.com",
	})
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for unsupported provider")
	}
	if _, ok := err.(*ConfigError); !ok {
		t.Errorf("err type = %T, want *ConfigError", err)
	}
}

func TestLoadConfigRequiresModel(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "anthropic",
		"LLM_API_KEY":  "sk-test",
		"LLM_MODEL":    "",
		"LLM_BASE_URL": "",
	})
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for missing model")
	}
}

func TestLoadConfigAnthropicRequiresAPIKey(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "anthropic",
		"LLM_API_KEY":  "",
		"LLM_MODEL":    "claude",
		"LLM_BASE_URL": "",
	})
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error when anthropic api key missing")
	}
}

func TestLoadConfigTreatsPlaceholderKeyAsMissing(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "anthropic",
		"LLM_API_KEY":  "your_key_here",
		"LLM_MODEL":    "claude",
		"LLM_BASE_URL": "",
	})
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error when api key is placeholder")
	}
}

func TestLoadConfigOpenAICompatibleAllowsEmptyKey(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "openai-compatible",
		"LLM_API_KEY":  "",
		"LLM_MODEL":    "gpt-4o",
		"LLM_BASE_URL": "https://api.example.com/v1",
	})
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.APIKey != "" {
		t.Errorf("APIKey = %q, want empty", cfg.APIKey)
	}
}

func TestLoadConfigOpenAICompatibleRequiresBaseURL(t *testing.T) {
	setEnv(t, map[string]string{
		"LLM_PROVIDER": "openai-compatible",
		"LLM_API_KEY":  "sk",
		"LLM_MODEL":    "gpt-4o",
		"LLM_BASE_URL": "",
	})
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for missing base url on openai-compatible")
	}
}
