package llm

import (
	"testing"
)

func TestAPIErrorIsToolSupportError(t *testing.T) {
	pos := []string{
		"Failed to translate tools payload",
		"tools is not supported by this model",
		"unknown field: tools",
	}
	for _, msg := range pos {
		if !(&APIError{Message: msg}).IsToolSupportError() {
			t.Errorf("expected tool-support signal for %q", msg)
		}
	}
	if (&APIError{Message: "rate limited"}).IsToolSupportError() {
		t.Error("false positive on unrelated message")
	}
}
