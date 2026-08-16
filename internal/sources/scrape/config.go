package scrape

// Loads and validates environment-driven configuration for the shared scraper client.

import (
	"fmt"
	"os"
	"strings"
)

const (
	ProviderFirecrawl = "firecrawl"
	ProviderCrawl4AI  = "crawl4ai"

	FirecrawlDefaultBaseURL = "https://api.firecrawl.dev"

	envBackend = "SCRAPER_BACKEND"
	envBaseURL = "SCRAPER_BASE_URL"
	envAPIKey  = "SCRAPER_API_KEY"
	placeholder = "your_key_here"
)

var SupportedProviders = []string{ProviderFirecrawl, ProviderCrawl4AI}

// Config holds the settings required to create a scrape client.
type Config struct {
	Provider string
	BaseURL  string
	APIKey   string
}

// LoadConfig reads scraper settings from environment variables and validates
// them. Returns a ConfigError describing what's missing when the config is
// incomplete; callers should treat that case as "scraper unavailable" and
// continue booting.
func LoadConfig() (Config, error) {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv(envBackend)))
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv(envBaseURL)), "/")
	apiKey := strings.TrimSpace(os.Getenv(envAPIKey))
	if isPlaceholderSecret(apiKey) {
		apiKey = ""
	}

	// If nothing is configured, return a clean "unavailable" ConfigError so the
	// caller can decide to boot scraper-less without logging noise.
	if provider == "" && baseURL == "" && apiKey == "" {
		return Config{}, &ConfigError{Message: "scraper not configured"}
	}

	if provider == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s (one of: %s)", envBackend, strings.Join(SupportedProviders, ", "))}
	}
	if !isSupportedProvider(provider) {
		return Config{}, &ConfigError{Message: fmt.Sprintf("unsupported %s %q; supported: %s", envBackend, provider, strings.Join(SupportedProviders, ", "))}
	}

	if baseURL == "" {
		switch provider {
		case ProviderFirecrawl:
			baseURL = FirecrawlDefaultBaseURL
		default:
			return Config{}, &ConfigError{Message: fmt.Sprintf("set %s", envBaseURL)}
		}
	}

	if provider == ProviderFirecrawl && apiKey == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s (required for Firecrawl)", envAPIKey)}
	}

	return Config{Provider: provider, BaseURL: baseURL, APIKey: apiKey}, nil
}

func isSupportedProvider(provider string) bool {
	for _, s := range SupportedProviders {
		if provider == s {
			return true
		}
	}
	return false
}

func isPlaceholderSecret(value string) bool {
	trimmed := strings.TrimSpace(value)
	trimmed = strings.Trim(trimmed, `"'`)
	return strings.EqualFold(trimmed, placeholder)
}
