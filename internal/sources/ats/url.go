package ats

import (
	"net/url"
	"strings"
)

// trackingParams is a denylist of well-known analytics / click-tracking query
// parameters that never affect which posting a URL points to. Anything with a
// "utm_" prefix is also stripped (see Canonicalize).
var trackingParams = map[string]struct{}{
	"gclid":    {},
	"fbclid":   {},
	"msclkid":  {},
	"yclid":    {},
	"dclid":    {},
	"mc_cid":   {},
	"mc_eid":   {},
	"_hsenc":   {},
	"_hsmi":    {},
	"ref":      {},
	"referrer": {},
	"src":      {},
	"source":   {},
	"gh_src":   {}, // Greenhouse referral tracking; gh_jid is the job id and is preserved
}

// Canonicalize strips tracking query parameters (utm_*, gclid, fbclid, ...)
// from rawURL. Non-tracking params, path, host, and fragment are preserved. If
// rawURL doesn't parse, it's returned unchanged so callers can still surface
// the original in error messages.
func Canonicalize(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return trimmed
	}
	if parsed.RawQuery == "" {
		return trimmed
	}
	q := parsed.Query()
	for key := range q {
		if isTrackingParam(key) {
			q.Del(key)
		}
	}
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

func isTrackingParam(key string) bool {
	lower := strings.ToLower(key)
	if strings.HasPrefix(lower, "utm_") {
		return true
	}
	_, ok := trackingParams[lower]
	return ok
}
