package discover

// Query construction for the site-scoped search step.

import (
	"strconv"
	"strings"
)

// seasonalYears returns the year of targetHireMonth. Aug 2026 → May 2027
// → year 2027 — the cycle the user would actually start if applied now.
func seasonalYears() []string {
	return []string{strconv.Itoa(targetHireMonth().Year())}
}

// buildSiteScopedQuery composes: site:{host} (roleGroup) (signalGroup)
// (locationGroup) (empGroup). Empty groups are dropped. OR is uppercase
// (Google requires it); space-separated groups AND implicitly.
//
// For scarce employment types (internship, new_grad), roles collapse to a
// single broader term (`broadRole`, or first variant as fallback) and
// signal keywords are dropped — the specific-variant + signal narrowing
// prunes the small pool to zero.
func buildSiteScopedQuery(host ATSHost, roles []string, broadRole string, signals, locations []string, employmentType string) string {
	if host.Host == "" {
		return ""
	}
	if isScarceEmployment(employmentType) {
		if broadRole != "" {
			roles = []string{broadRole}
		} else if len(roles) > 0 {
			roles = roles[:1]
		}
		signals = nil
	}
	parts := []string{"site:" + host.Host}
	groups := [][]string{roles, signals, locations, employmentTitleKeywords[employmentType]}
	// Scarce (cycle-driven) roles: also constrain to the current+next
	// year. Fresh internship/new-grad postings virtually always name the
	// cycle year in the title or body; timeless-looking ones are usually
	// evergreen stubs or stale.
	if isScarceEmployment(employmentType) {
		groups = append(groups, seasonalYears())
	}
	for _, group := range groups {
		if g := composeORGroup(group); g != "" {
			parts = append(parts, g)
		}
	}
	return strings.Join(parts, " ")
}

// composeORGroup formats a term list as a Google-search OR group. One term
// returns `"term"`; multiple returns `("t1" OR "t2" OR ...)`. Empty input
// returns "". Dedupes case-insensitively. Terms are quoted so multi-word
// phrases stay intact.
func composeORGroup(terms []string) string {
	quoted := make([]string, 0, len(terms))
	seen := map[string]struct{}{}
	for _, v := range terms {
		s := strings.TrimSpace(v)
		if s == "" {
			continue
		}
		key := strings.ToLower(s)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		quoted = append(quoted, `"`+s+`"`)
	}
	if len(quoted) == 0 {
		return ""
	}
	if len(quoted) == 1 {
		return quoted[0]
	}
	return "(" + strings.Join(quoted, " OR ") + ")"
}
