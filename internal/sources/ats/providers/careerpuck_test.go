package providers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/ats"
)

func TestCareerpuckSupports(t *testing.T) {
	c := NewCareerpuck()
	cases := map[string]bool{
		"https://app.careerpuck.com/job-board/acme/job/SdorDguK":       true,
		"https://app.careerpuck.com/job-board/acme/job/8174947":        true,
		"https://app.careerpuck.com/job-board/acme/job/8174947/apply":  true,
		"https://app.careerpuck.com/job-board/acme":                    false,
		"https://app.careerpuck.com/job-board/acme/job/":               false,
		"https://app.careerpuck.com/":                                  false,
		"https://static.careerpuck.com/job-board/acme/job/abc":         false,
		"https://boards.greenhouse.io/acme/jobs/123":                   false,
		"not a url":                                                    false,
	}
	for in, want := range cases {
		if got := c.Supports(in); got != want {
			t.Errorf("Supports(%q) = %v, want %v", in, got, want)
		}
	}
}

// boardFixture mirrors the real shape returned by
// https://api.careerpuck.com/v1/public/job-boards/{board}, including Puck's
// double-encoded `content` (entities inside an already entity-encoded HTML
// string).
const boardFixture = `{
  "employerProfile": {"name": "Acme Inc."},
  "jobs": [
    {
      "permalink": "SdorDguK",
      "atsSourceId": "8174947",
      "atsSourcePlatform": "greenhouse",
      "title": " Senior Engineer ",
      "content": "&lt;p&gt;Build things at &lt;strong&gt;Acme&lt;&sol;strong&gt;&comma; remotely&period;&lt;&sol;p&gt;",
      "location": "Remote - US",
      "departments": [{"name": "Engineering"}, {"name": "Platform"}],
      "offices": [{"name": "Remote UK"}],
      "workType": "Full-time",
      "salaryDescription": "$180k-$220k",
      "publicUrl": "https://app.careerpuck.com/job-board/acme/job/8174947",
      "postedAt": "2026-08-01T12:00:00.000Z"
    },
    {
      "permalink": "OtherJob",
      "atsSourceId": "999",
      "title": "Other",
      "content": "&lt;p&gt;other&lt;&sol;p&gt;"
    }
  ]
}`

func newCareerpuckServer(t *testing.T, expectBoard string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/public/job-boards/"+expectBoard {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(boardFixture))
	}))
}

func TestCareerpuckFetchByPermalink(t *testing.T) {
	server := newCareerpuckServer(t, "acme")
	defer server.Close()

	c := &Careerpuck{client: server.Client(), apiBase: server.URL}
	got, err := c.Fetch(context.Background(), "https://app.careerpuck.com/job-board/acme/job/SdorDguK")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "careerpuck" {
		t.Errorf("Provider = %q, want careerpuck", got.Provider)
	}
	if got.Title != "Senior Engineer" {
		t.Errorf("Title = %q", got.Title)
	}
	if got.Company != "Acme Inc." {
		t.Errorf("Company = %q", got.Company)
	}
	if got.Location != "Remote - US" {
		t.Errorf("Location = %q", got.Location)
	}
	if got.Department != "Engineering" {
		t.Errorf("Department = %q, want first departments[] entry", got.Department)
	}
	if got.EmploymentType != "Full-time" {
		t.Errorf("EmploymentType = %q", got.EmploymentType)
	}
	if got.Compensation != "$180k-$220k" {
		t.Errorf("Compensation = %q", got.Compensation)
	}
	if got.ApplyURL != "https://app.careerpuck.com/job-board/acme/job/8174947" {
		t.Errorf("ApplyURL = %q, want the Puck publicUrl", got.ApplyURL)
	}
	// Regression: Puck double-encodes named entities (&sol; &comma; &period;).
	// The description must decode to plain text with the punctuation restored;
	// htmlToText may insert whitespace around former inline tags, so match on
	// substrings rather than the exact string.
	for _, want := range []string{"Build things at", "Acme", "remotely."} {
		if !strings.Contains(got.DescriptionText, want) {
			t.Errorf("DescriptionText = %q, missing %q", got.DescriptionText, want)
		}
	}
	if got.PostedAt.IsZero() || got.PostedAt.Format("2006-01-02") != "2026-08-01" {
		t.Errorf("PostedAt = %v, want 2026-08-01", got.PostedAt)
	}
}

// Puck's own publicUrl uses atsSourceId, so most real-world URLs users paste
// carry the numeric id instead of the short permalink. Fetch must resolve
// both.
func TestCareerpuckFetchByAtsSourceID(t *testing.T) {
	server := newCareerpuckServer(t, "acme")
	defer server.Close()

	c := &Careerpuck{client: server.Client(), apiBase: server.URL}
	got, err := c.Fetch(context.Background(), "https://app.careerpuck.com/job-board/acme/job/8174947")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Title != "Senior Engineer" {
		t.Errorf("Title = %q, want the atsSourceId=8174947 job", got.Title)
	}
}

// Board found but no job with the requested id → ErrPostingNotFound so
// discover.extractPostings drops the dead link.
func TestCareerpuckFetchMissingJob(t *testing.T) {
	server := newCareerpuckServer(t, "acme")
	defer server.Close()

	c := &Careerpuck{client: server.Client(), apiBase: server.URL}
	_, err := c.Fetch(context.Background(), "https://app.careerpuck.com/job-board/acme/job/does-not-exist")
	if !errors.Is(err, ats.ErrPostingNotFound) {
		t.Fatalf("expected ats.ErrPostingNotFound, got %v", err)
	}
}

// Board 404 (unknown company) must also surface as ErrPostingNotFound —
// httpfetch translates the upstream 404 for us.
func TestCareerpuckFetchBoard404(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	defer server.Close()

	c := &Careerpuck{client: server.Client(), apiBase: server.URL}
	_, err := c.Fetch(context.Background(), "https://app.careerpuck.com/job-board/nobody/job/123")
	if !errors.Is(err, ats.ErrPostingNotFound) {
		t.Fatalf("expected ats.ErrPostingNotFound, got %v", err)
	}
}
