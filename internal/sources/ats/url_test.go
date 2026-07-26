package ats

import "testing"

func TestCanonicalize(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"no query", "https://boards.greenhouse.io/acme/jobs/123", "https://boards.greenhouse.io/acme/jobs/123"},
		{
			"strips utm_*",
			"https://boards.greenhouse.io/acme/jobs/123?utm_source=linkedin&utm_medium=cpc",
			"https://boards.greenhouse.io/acme/jobs/123",
		},
		{
			"keeps meaningful params",
			"https://jobs.example.com/apply?jobId=42&utm_campaign=summer",
			"https://jobs.example.com/apply?jobId=42",
		},
		{
			"strips click ids",
			"https://x.example/y?gclid=abc&fbclid=def&keep=1",
			"https://x.example/y?keep=1",
		},
		{
			"strips gh_src but keeps gh_jid",
			"https://boards.greenhouse.io/acme/jobs/123?gh_src=abc&gh_jid=999",
			"https://boards.greenhouse.io/acme/jobs/123?gh_jid=999",
		},
		{
			"case-insensitive param names",
			"https://x.example/y?UTM_Source=foo&Keep=1",
			"https://x.example/y?Keep=1",
		},
		{
			"preserves fragment",
			"https://x.example/y?utm_source=z#section",
			"https://x.example/y#section",
		},
		{"trims whitespace", "  https://x.example/y  ", "https://x.example/y"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Canonicalize(tc.in)
			if got != tc.want {
				t.Errorf("Canonicalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
