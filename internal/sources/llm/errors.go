package llm

// Defines error types returned by the shared LLM client and configuration loader.

import (
	"errors"
	"strings"
)

// ErrClientNotConfigured is the sentinel returned when a service needs an
// LLM client but none was configured. HTTP layer localizes it.
var ErrClientNotConfigured = errors.New("llm client not configured")

// RequireClient returns ErrClientNotConfigured when c is nil.
func RequireClient(c Client) error {
	if c == nil {
		return ErrClientNotConfigured
	}
	return nil
}

// InputError marks a client-input failure (empty/malformed payload, missing
// prerequisite). The HTTP layer unwraps it to 400 so these don't get
// miscounted as gateway failures. Kept i18n-free so the llm package stays
// independent of internal/i18n — callers pre-translate the message.
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

// NewInputError wraps a pre-translated message as an InputError.
func NewInputError(msg string) *InputError { return &InputError{Msg: msg} }

// Error reports local client-side failures before or during request construction.
type Error struct {
	Message string
}

// Error returns the underlying client-side error message.
func (e *Error) Error() string {
	return e.Message
}

// ConfigError reports invalid or incomplete LLM configuration.
type ConfigError struct {
	Message string
}

// Error returns the configuration validation message.
func (e *ConfigError) Error() string {
	return e.Message
}

// APIError reports failures returned by or while decoding the LLM provider response.
type APIError struct {
	Message string
}

// Error returns the provider or response-decoding error message.
func (e *APIError) Error() string {
	return e.Message
}

// IsToolSupportError reports whether the provider error message indicates unsupported tool use.
func (e *APIError) IsToolSupportError() bool {
	msg := strings.ToLower(e.Message)
	signals := []string{
		"failed to translate",
		"tools is not supported",
		"tool_use is not supported",
		"unrecognized request argument: tools",
		"does not support tools",
		"invalid parameter: tools",
		"unknown field: tools",
	}
	for _, signal := range signals {
		if strings.Contains(msg, signal) {
			return true
		}
	}
	return false
}
