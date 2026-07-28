package llm

import "strings"

var suspiciousTextMarkers = []string{
	"ignore previous instructions",
	"previous instructions",
	"prior instructions",
	"earlier instructions",
	"previous guidance",
	"prior guidance",
	"earlier guidance",
	"system prompt",
	"developer prompt",
	"hidden instructions",
	"internal instructions",
	"hidden prompt",
	"secret prompt",
	"underlying prompt",
	"initial prompt",
	"previous prompt",
	"earlier prompt",
	"show the prompt",
	"reveal the prompt",
	"print the prompt",
	"display the prompt",
	"follow these instructions",
	"ignore all instructions",
	"disregard instructions",
	"private note",
	"reveal private notes",
	"private notes",
	"internal note",
	"internal notes",
	"confidential note",
	"confidential notes",
	"hidden context",
	"internal context",
	"secret context",
	"unseen context",
	"complete this sentence",
}

// SanitizeText trims free text and drops obvious prompt-injection meta content.
func SanitizeText(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if IsSuspiciousText(trimmed) {
		return ""
	}
	return trimmed
}

// IsSuspiciousText reports whether text contains common prompt-injection markers.
func IsSuspiciousText(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	for _, marker := range suspiciousTextMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
