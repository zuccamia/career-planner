package scrape

// Loads and validates environment-driven configuration for the shared scraper client.

import (
	"fmt"
	"os"
	"strings"
)

const (
	BackendFirecrawl = "firecrawl"
	BackendCrawl4AI  = "crawl4ai"

	FirecrawlDefaultBaseURL = "https://api.firecrawl.dev"

	envBackend  = "SCRAPER_BACKEND"
	envBaseURL  = "SCRAPER_BASE_URL"
	envAPIKey   = "SCRAPER_API_KEY"
	placeholder = "your_key_here"
)

var SupportedBackends = []string{BackendFirecrawl, BackendCrawl4AI}

// Config holds the settings required to create a scrape client.
type Config struct {
	Backend string
	BaseURL string
	APIKey  string
}

// LoadConfig reads scraper settings from environment variables and validates
// them. Returns a ConfigError describing what's missing when the config is
// incomplete; callers should treat that case as "scraper unavailable" and
// continue booting.
func LoadConfig() (Config, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv(envBackend)))
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv(envBaseURL)), "/")
	apiKey := strings.TrimSpace(os.Getenv(envAPIKey))
	if isPlaceholderSecret(apiKey) {
		apiKey = ""
	}

	// If nothing is configured, return a clean "unavailable" ConfigError so the
	// caller can decide to boot scraper-less without logging noise.
	if backend == "" && baseURL == "" && apiKey == "" {
		return Config{}, &ConfigError{Message: "scraper not configured"}
	}

	if backend == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s (one of: %s)", envBackend, strings.Join(SupportedBackends, ", "))}
	}
	if !isSupportedBackend(backend) {
		return Config{}, &ConfigError{Message: fmt.Sprintf("unsupported %s %q; supported: %s", envBackend, backend, strings.Join(SupportedBackends, ", "))}
	}

	if baseURL == "" {
		switch backend {
		case BackendFirecrawl:
			baseURL = FirecrawlDefaultBaseURL
		default:
			return Config{}, &ConfigError{Message: fmt.Sprintf("set %s", envBaseURL)}
		}
	}

	if backend == BackendFirecrawl && apiKey == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s (required for Firecrawl)", envAPIKey)}
	}

	return Config{Backend: backend, BaseURL: baseURL, APIKey: apiKey}, nil
}

func isSupportedBackend(backend string) bool {
	for _, s := range SupportedBackends {
		if backend == s {
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
