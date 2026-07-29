package i18n

import (
	"fmt"
	"strings"
)

// parseAcceptLanguage returns language tags from an Accept-Language header,
// sorted by q-weight (highest first), then by source order for ties. Weights
// default to 1.0 when absent.
func parseAcceptLanguage(header string) []string {
	if header == "" {
		return nil
	}
	type entry struct {
		tag string
		q   float64
		idx int
	}
	var entries []entry
	for i, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		tag, q := part, 1.0
		if semi := strings.Index(part, ";"); semi >= 0 {
			tag = strings.TrimSpace(part[:semi])
			if eq := strings.Index(part[semi:], "q="); eq >= 0 {
				fmt.Sscanf(part[semi+eq+2:], "%f", &q)
			}
		}
		entries = append(entries, entry{strings.ToLower(tag), q, i})
	}
	// Insertion sort — Accept-Language is short in practice.
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0; j-- {
			a, b := entries[j-1], entries[j]
			if a.q < b.q || (a.q == b.q && a.idx > b.idx) {
				entries[j-1], entries[j] = b, a
				continue
			}
			break
		}
	}
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.tag
	}
	return out
}
