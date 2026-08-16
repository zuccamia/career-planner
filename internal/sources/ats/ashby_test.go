package ats

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAshbySupports(t *testing.T) {
	a := NewAshby()
	cases := map[string]bool{
		"https://jobs.ashbyhq.com/acme/uuid-1":     true,
		"https://jobs.ashbyhq.com/acme":            false,
		"https://boards.greenhouse.io/acme/jobs/1": false,
		"not a url":                                false,
	}
	for in, want := range cases {
		if got := a.Supports(in); got != want {
			t.Errorf("Supports(%q) = %v, want %v", in, got, want)
		}
	}
}

// ashbyPageHTML mimics the JSON-LD JobPosting block that Ashby ships on its
// single-posting HTML pages, including the HTML-encoded description.
const ashbyPageHTML = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Software Engineer Intern",
  "description": "&lt;p&gt;Build the platform at &lt;strong&gt;Serval&lt;/strong&gt;.&lt;/p&gt;",
  "employmentType": "FULL_TIME",
  "hiringOrganization": {"@type": "Organization", "name": "Serval"},
  "jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress", "addressLocality": "San Francisco", "addressRegion": "California", "addressCountry": "United States"}},
  "baseSalary": {"@type": "MonetaryAmount", "currency": "USD", "value": {"@type": "QuantitativeValue", "minValue": 11000, "maxValue": 11000, "unitText": "MONTH"}},
  "datePosted": "2026-08-03"
}
</script>
</head><body></body></html>`

func TestAshbyFetchFromJSONLD(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/Serval/d7fb089c-db8a-4877-a5f3-73a09e67f54b"
		if r.URL.Path != want {
			t.Errorf("path = %q, want %q", r.URL.Path, want)
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, ashbyPageHTML)
	}))
	defer server.Close()

	a := &Ashby{client: server.Client(), pageBase: server.URL}
	inputURL := "https://jobs.ashbyhq.com/Serval/d7fb089c-db8a-4877-a5f3-73a09e67f54b"
	got, err := a.Fetch(context.Background(), inputURL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Provider != "ashby" || got.Title != "Software Engineer Intern" {
		t.Errorf("unexpected posting: %+v", got)
	}
	if got.Company != "Serval" {
		t.Errorf("Company = %q, want Serval", got.Company)
	}
	if got.Location != "San Francisco, California, United States" {
		t.Errorf("Location = %q", got.Location)
	}
	if got.Compensation != "USD 11000/month" {
		t.Errorf("Compensation = %q", got.Compensation)
	}
	if got.ApplyURL != inputURL {
		t.Errorf("ApplyURL = %q, want input url", got.ApplyURL)
	}
	if !strings.Contains(got.DescriptionText, "Build the platform at Serval") {
		t.Errorf("DescriptionText = %q", got.DescriptionText)
	}
	if got.PostedAt.IsZero() || got.PostedAt.Format("2006-01-02") != "2026-08-03" {
		t.Errorf("PostedAt = %v, want datePosted 2026-08-03", got.PostedAt)
	}
	if got.EmploymentType != "FULL_TIME" {
		t.Errorf("EmploymentType = %q, want raw schema.org value %q", got.EmploymentType, "FULL_TIME")
	}
}

func TestAshbyFetchMissingJSONLD(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "<html><body>no schema here</body></html>")
	}))
	defer server.Close()

	a := &Ashby{client: server.Client(), pageBase: server.URL}
	_, err := a.Fetch(context.Background(), "https://jobs.ashbyhq.com/acme/uuid-1")
	if err == nil || !strings.Contains(err.Error(), "JobPosting") {
		t.Fatalf("expected missing-JSON-LD error, got %v", err)
	}
}

func TestAshbyFetch404(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	defer server.Close()

	a := &Ashby{client: server.Client(), pageBase: server.URL}
	_, err := a.Fetch(context.Background(), "https://jobs.ashbyhq.com/acme/deleted-role")
	// discover.extractPostings uses errors.Is(err, ErrPostingNotFound) to
	// drop dead-link URLs before they reach the ranker. Assert on the
	// sentinel, not the error string.
	if !errors.Is(err, ErrPostingNotFound) {
		t.Fatalf("expected ErrPostingNotFound, got %v", err)
	}
}

// ashbyPageNoSalaryHTML mimics a real Ashby page for a role that doesn't
// publish a salary — baseSalary object is absent from the JSON-LD entirely.
const ashbyPageNoSalaryHTML = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Backend Engineer",
  "description": "&lt;p&gt;Do work.&lt;/p&gt;",
  "employmentType": "FULL_TIME",
  "hiringOrganization": {"@type": "Organization", "name": "Acme"},
  "jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress", "addressLocality": "Remote"}}
}
</script>
</head><body></body></html>`

func TestAshbyFetchEmptySalary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, ashbyPageNoSalaryHTML)
	}))
	defer server.Close()

	a := &Ashby{client: server.Client(), pageBase: server.URL}
	got, err := a.Fetch(context.Background(), "https://jobs.ashbyhq.com/acme/backend")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Compensation != "" {
		t.Errorf("Compensation = %q, want empty when baseSalary absent", got.Compensation)
	}
}
