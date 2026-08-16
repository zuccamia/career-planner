package util

import (
	"testing"
	"time"
)

func TestFirstNonEmpty(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want string
	}{
		{"empty slice", nil, ""},
		{"all empty strings", []string{"", "", ""}, ""},
		{"all whitespace", []string{"  ", "\t", "\n"}, ""},
		{"first non-empty", []string{"a", "b"}, "a"},
		{"trims leading/trailing", []string{"  hello  "}, "hello"},
		{"skips whitespace-only entries", []string{"", "  ", "found"}, "found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FirstNonEmpty(tc.in...); got != tc.want {
				t.Errorf("FirstNonEmpty(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestCoalesceTime(t *testing.T) {
	nonUTC := time.Date(2026, 8, 10, 12, 0, 0, 0, time.FixedZone("EDT", -4*3600))
	utc := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)

	t.Run("all zero returns nil", func(t *testing.T) {
		if got := CoalesceTime(time.Time{}, time.Time{}); got != nil {
			t.Errorf("expected nil for all-zero inputs, got %v", got)
		}
	})

	t.Run("empty args returns nil", func(t *testing.T) {
		if got := CoalesceTime(); got != nil {
			t.Errorf("expected nil for empty args, got %v", got)
		}
	})

	t.Run("first non-zero wins", func(t *testing.T) {
		later := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
		got := CoalesceTime(time.Time{}, utc, later)
		if got == nil || !got.Equal(utc) {
			t.Errorf("CoalesceTime picked %v, want first non-zero %v", got, utc)
		}
	})

	t.Run("normalizes to UTC", func(t *testing.T) {
		got := CoalesceTime(nonUTC)
		if got == nil {
			t.Fatal("expected non-nil")
		}
		if got.Location() != time.UTC {
			t.Errorf("Location = %v, want UTC", got.Location())
		}
		if !got.Equal(nonUTC) {
			t.Errorf("returned time %v not equal to input %v", got, nonUTC)
		}
	})
}

func TestParseTimestamp(t *testing.T) {
	layouts := []string{time.RFC3339, "2006-01-02"}

	cases := []struct {
		name    string
		values  []string
		wantISO string // "" for zero
	}{
		{"empty values", nil, ""},
		{"all whitespace", []string{"", "  "}, ""},
		{"unparseable", []string{"not a date"}, ""},
		{"first parseable wins", []string{"garbage", "2026-08-10"}, "2026-08-10T00:00:00Z"},
		{"RFC3339 preferred over date-only when both parseable", []string{"2026-08-10T15:30:00Z"}, "2026-08-10T15:30:00Z"},
		{"skips empty then parses", []string{"", "  ", "2026-08-10"}, "2026-08-10T00:00:00Z"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseTimestamp(layouts, tc.values...)
			if tc.wantISO == "" {
				if !got.IsZero() {
					t.Errorf("ParseTimestamp(%v) = %v, want zero", tc.values, got)
				}
				return
			}
			want, _ := time.Parse(time.RFC3339, tc.wantISO)
			if !got.Equal(want) {
				t.Errorf("ParseTimestamp(%v) = %v, want %v", tc.values, got, want)
			}
			if got.Location() != time.UTC {
				t.Errorf("Location = %v, want UTC", got.Location())
			}
		})
	}
}
