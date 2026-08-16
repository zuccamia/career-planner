package search

// Env-driven config for the search client. SEARCH_BACKEND mirrors
// SCRAPER_BACKEND; only "searxng" is supported today.

import (
	"fmt"
	"os"
	"strings"
	"time"
)

const ProviderSearXNG = "searxng"

const (
	envBackend = "SEARCH_BACKEND"
	envBaseURL = "SEARCH_BASE_URL"
)

var SupportedProviders = []string{ProviderSearXNG}

// Config holds the settings required to create a search client.
type Config struct {
	Provider    string
	BaseURL     string
	HTTPTimeout time.Duration
}

// LoadConfig reads search settings from env. ConfigError → app boot disables
// discover cleanly.
func LoadConfig() (Config, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv(envBackend)))
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv(envBaseURL)), "/")

	if backend == "" && baseURL == "" {
		return Config{}, &ConfigError{Message: "search not configured"}
	}
	if backend == "" {
		backend = ProviderSearXNG
	}
	if !isSupportedProvider(backend) {
		return Config{}, &ConfigError{Message: fmt.Sprintf("unsupported %s %q; supported: %s", envBackend, backend, strings.Join(SupportedProviders, ", "))}
	}
	if baseURL == "" {
		return Config{}, &ConfigError{Message: fmt.Sprintf("set %s", envBaseURL)}
	}
	return Config{Provider: backend, BaseURL: baseURL}, nil
}

func isSupportedProvider(provider string) bool {
	for _, s := range SupportedProviders {
		if provider == s {
			return true
		}
	}
	return false
}

// ConfigError reports invalid or incomplete search configuration.
type ConfigError struct {
	Message string
}

func (e *ConfigError) Error() string { return e.Message }
