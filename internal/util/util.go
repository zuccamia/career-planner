// Package util collects small generic helpers shared across the internal
// tree. Keep entries here narrow and pure — anything domain-specific
// belongs with its domain package.
package util

import (
	"strings"
	"time"
)

// FirstNonEmpty returns the first argument whose trimmed value is
// non-empty, or "" if all are empty.
func FirstNonEmpty(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// CoalesceTime returns a pointer to the first non-zero time, normalized to
// UTC, or nil when every input is zero.
func CoalesceTime(times ...time.Time) *time.Time {
	for _, t := range times {
		if !t.IsZero() {
			u := t.UTC()
			return &u
		}
	}
	return nil
}

// ParseTimestamp tries each layout on each value in order and returns the
// first parseable timestamp in UTC, or the zero time if nothing parses.
// Empty values are skipped. Callers pass a fixed layout list first, then
// the raw candidate strings.
func ParseTimestamp(layouts []string, values ...string) time.Time {
	for _, raw := range values {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		for _, layout := range layouts {
			if ts, err := time.Parse(layout, s); err == nil {
				return ts.UTC()
			}
		}
	}
	return time.Time{}
}
