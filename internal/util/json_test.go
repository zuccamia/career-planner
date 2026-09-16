package util

import (
	"encoding/json"
	"testing"
)

func TestFlexIntUnmarshal(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want FlexInt
	}{
		{"number", `2024`, 2024},
		{"quoted number", `"2024"`, 2024},
		{"quoted with whitespace", `"  2024  "`, 2024},
		{"float", `2024.7`, 2024},
		{"quoted float", `"2024.7"`, 2024},
		{"negative", `-5`, -5},
		{"quoted negative", `"-5"`, -5},
		{"null", `null`, 0},
		{"empty string", `""`, 0},
		{"non-numeric string", `"soon"`, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got FlexInt
			if err := json.Unmarshal([]byte(tc.in), &got); err != nil {
				t.Fatalf("unmarshal %s: %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("FlexInt(%s) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

// Regression: LLM-decoded structs must accept a quoted year — the original
// symptom was `cannot unmarshal string into Go struct field .year of type int`
// on extract-job-description.
func TestFlexIntInStructAcceptsQuotedYear(t *testing.T) {
	type payload struct {
		Year FlexInt `json:"year"`
	}
	var p payload
	if err := json.Unmarshal([]byte(`{"year":"2026"}`), &p); err != nil {
		t.Fatalf("decode quoted year: %v", err)
	}
	if p.Year != 2026 {
		t.Errorf("Year = %d, want 2026", p.Year)
	}
}
