package llm

// Loads and validates environment-driven configuration for the shared LLM client.

import (
	"fmt"
	"os"
	"strings"
)

const (
	ProviderAnthropic        = "anthropic"
	ProviderOpenAICompatible = "openai-compatible"
	AnthropicDefaultBaseURL  = "https://api.anthropic.com/v1"
	defaultProviderEnvVar    = "LLM_PROVIDER"
	defaultAPIKeyEnvVar      = "LLM_API_KEY"
	defaultModelEnvVar       = "LLM_MODEL"
	defaultBaseURLEnvVar     = "LLM_BASE_URL"
	placeholderAPIKey        = "your_key_here"
)

var SupportedProviders = []string{ProviderAnthropic, ProviderOpenAICompatible}

// Config holds the provider settings required to create an LLM client.
type Config struct {
	Provider string
	BaseURL  string
	Model    string
	APIKey   string
}

// LoadConfig reads LLM settings from environment variables and validates them.
func LoadConfig() (Config, error) {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv(defaultProviderEnvVar)))
	if provider == "" {
		provider = ProviderAnthropic
	}
	if !isSupportedProvider(provider) {
		return Config{}, &ConfigError{Message: fmt.Sprintf("unsupported %s %q; supported: %s", defaultProviderEnvVar, provider, strings.Join(SupportedProviders, ", "))}
	}

	baseURL := strings.TrimSpace(os.Getenv(defaultBaseURLEnvVar))
	if baseURL == "" && provider == ProviderAnthropic {
		baseURL = AnthropicDefaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s", defaultBaseURLEnvVar)}
	}

	model := strings.TrimSpace(os.Getenv(defaultModelEnvVar))
	if model == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s", defaultModelEnvVar)}
	}

	apiKey := strings.TrimSpace(os.Getenv(defaultAPIKeyEnvVar))
	if isPlaceholderSecret(apiKey) {
		apiKey = ""
	}
	if provider == ProviderAnthropic && apiKey == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s", defaultAPIKeyEnvVar)}
	}

	return Config{
		Provider: provider,
		BaseURL:  baseURL,
		Model:    model,
		APIKey:   apiKey,
	}, nil
}

func isSupportedProvider(provider string) bool {
	for _, supported := range SupportedProviders {
		if provider == supported {
			return true
		}
	}
	return false
}

func isPlaceholderSecret(value string) bool {
	trimmed := strings.TrimSpace(value)
	trimmed = strings.Trim(trimmed, `"'`)
	return strings.EqualFold(trimmed, placeholderAPIKey)
}
