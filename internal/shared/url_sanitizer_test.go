package shared

import "testing"

func TestSanitizeHTTPURL(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "blank", input: "", want: ""},
		{name: "trim whitespace", input: "  https://example.com/path?q=1  ", want: "https://example.com/path?q=1"},
		{name: "http", input: "http://example.com", want: "http://example.com"},
		{name: "https", input: "https://example.com", want: "https://example.com"},
		{name: "malformed", input: "://bad", want: ""},
		{name: "missing host", input: "https:///missing-host", want: ""},
		{name: "ftp rejected", input: "ftp://example.com", want: ""},
		{name: "javascript rejected", input: "javascript:alert(1)", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SanitizeHTTPURL(tt.input); got != tt.want {
				t.Fatalf("SanitizeHTTPURL(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSanitizeURL(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "blank", input: "", want: ""},
		{name: "trim whitespace", input: "  https://example.com/blog  ", want: "https://example.com/blog"},
		{name: "valid https", input: "https://example.com", want: "https://example.com"},
		{name: "valid mailto hostless rejected", input: "mailto:test@example.com", want: ""},
		{name: "missing scheme", input: "example.com/path", want: ""},
		{name: "missing host", input: "custom:///path", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SanitizeURL(tt.input); got != tt.want {
				t.Fatalf("SanitizeURL(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
