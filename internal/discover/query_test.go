package discover

import (
	"strings"
	"testing"
	"time"
)

func TestBuildSiteScopedQuery(t *testing.T) {
	host := ATSHost{Host: "boards.greenhouse.io", Provider: "greenhouse"}
	roles := []string{"Backend Engineer", "Software Engineer, Backend"}
	signals := []string{"fintech", "payments"}
	locations := []string{"Remote", "New York"}

	// Full-time (non-scarce): all OR-groups present.
	q := buildSiteScopedQuery(host, roles, "", signals, locations, "full_time")
	if !strings.HasPrefix(q, "site:boards.greenhouse.io") {
		t.Errorf("query missing site prefix: %q", q)
	}
	if !strings.Contains(q, `"Backend Engineer" OR "Software Engineer, Backend"`) {
		t.Errorf("query missing role OR-group: %q", q)
	}
	if !strings.Contains(q, `"fintech" OR "payments"`) {
		t.Errorf("query missing signal OR-group: %q", q)
	}
	if !strings.Contains(q, `"Remote" OR "New York"`) {
		t.Errorf("query missing location OR-group: %q", q)
	}
	if strings.Contains(q, " or ") {
		t.Errorf("OR must be uppercase: %q", q)
	}

	// Internship (scarce): with broad_role provided, roles collapse to
	// that single broader term; signals dropped; employment OR-group present.
	q = buildSiteScopedQuery(host, roles, "Software Engineer", signals, locations, "internship")
	if strings.Contains(q, `"fintech"`) {
		t.Errorf("intern query should drop signal group, got: %q", q)
	}
	if !strings.Contains(q, `"Software Engineer"`) {
		t.Errorf("intern query should use broad_role, got: %q", q)
	}
	if strings.Contains(q, `"Backend Engineer"`) {
		t.Errorf("intern query should not include specific variants when broad_role is set: %q", q)
	}
	if !strings.Contains(q, `"intern" OR "internship" OR "co-op"`) {
		t.Errorf("intern query missing employment OR-group: %q", q)
	}
	// Scarce employment: target-hire year (now + 9 months) is appended
	// so the engine filters out prior cycles.
	restore := nowLocal
	// August 2026 + 9 months → May 2027 → year 2027.
	nowLocal = func() time.Time { return time.Date(2026, time.August, 15, 12, 0, 0, 0, time.Local) }
	q = buildSiteScopedQuery(host, roles, "Software Engineer", signals, locations, "internship")
	nowLocal = restore
	if !strings.Contains(q, `"2027"`) {
		t.Errorf("intern query should include target-hire year OR-group: %q", q)
	}
	if strings.Contains(q, `"2026"`) {
		t.Errorf("intern query in Aug 2026 should target 2027 alone, not include current year: %q", q)
	}

	// March + 9 months → December same year → single year, current.
	nowLocal = func() time.Time { return time.Date(2026, time.March, 15, 12, 0, 0, 0, time.Local) }
	q = buildSiteScopedQuery(host, roles, "Software Engineer", signals, locations, "internship")
	nowLocal = restore
	if !strings.Contains(q, `"2026"`) {
		t.Errorf("intern query in Mar should target 2026: %q", q)
	}

	// Non-scarce: no year OR-group appended.
	if got := buildSiteScopedQuery(host, roles, "", signals, locations, "full_time"); strings.Contains(got, `"2026"`) || strings.Contains(got, `"2027"`) {
		t.Errorf("full-time query should not include year group: %q", got)
	}

	// Internship without broad_role: fall back to first role variant.
	q = buildSiteScopedQuery(host, roles, "", signals, locations, "internship")
	if !strings.Contains(q, `"Backend Engineer"`) {
		t.Errorf("intern query should fall back to first variant when broad_role empty: %q", q)
	}

	// Empty groups get dropped, single-term groups quoted without parens.
	q = buildSiteScopedQuery(host, []string{"Backend Engineer"}, "", nil, nil, "")
	if q != `site:boards.greenhouse.io "Backend Engineer"` {
		t.Errorf("minimal query wrong: %q", q)
	}

	// Empty host → empty query (caller should skip).
	if got := buildSiteScopedQuery(ATSHost{}, roles, "", nil, nil, ""); got != "" {
		t.Errorf("expected empty query for empty host, got %q", got)
	}
}

func TestComposeORGroup(t *testing.T) {
	if got := composeORGroup(nil); got != "" {
		t.Errorf("nil → %q, want empty", got)
	}
	if got := composeORGroup([]string{"", "  "}); got != "" {
		t.Errorf("all-whitespace → %q, want empty", got)
	}
	if got := composeORGroup([]string{"Backend Engineer"}); got != `"Backend Engineer"` {
		t.Errorf("single term → %q", got)
	}
	if got := composeORGroup([]string{"A", "B", "C"}); got != `("A" OR "B" OR "C")` {
		t.Errorf("multi-term → %q", got)
	}
	if got := composeORGroup([]string{"Go", "go", "GO", "Rust"}); got != `("Go" OR "Rust")` {
		t.Errorf("dedupe → %q", got)
	}
}

func TestEmploymentExpansions_TableCoversKnownTypes(t *testing.T) {
	for _, k := range []string{"internship", "new_grad"} {
		if _, ok := employmentTitleKeywords[k]; !ok {
			t.Errorf("expected employment expansion for %q", k)
		}
	}
	for _, k := range []string{"full_time", "contract", "open", ""} {
		if _, ok := employmentTitleKeywords[k]; ok {
			t.Errorf("expected NO expansion for %q (would over-narrow queries)", k)
		}
	}
}
