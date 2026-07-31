package scrape

// Error types returned by the scrape client and configuration loader.

// Error reports local client-side failures before or during request construction.
type Error struct {
	Message string
}

func (e *Error) Error() string { return e.Message }

// ConfigError reports invalid or incomplete scraper configuration.
type ConfigError struct {
	Message string
}

func (e *ConfigError) Error() string { return e.Message }

// APIError reports failures returned by the scraper backend HTTP call.
type APIError struct {
	Message string
	Status  int
}

func (e *APIError) Error() string { return e.Message }
