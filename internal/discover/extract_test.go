package discover

import "testing"

func TestCompanyFromURL(t *testing.T) {
	loadProvidersForTestDefaults(t)

	cases := map[string]struct {
		url  string
		want string
	}{
		// slug_in_path providers → tenant slug is the first path segment,
		// prettified for display.
		"workable single-word tenant":         {"https://apply.workable.com/stripe/j/CODE", "Stripe"},
		"workable kebab-case tenant":          {"https://apply.workable.com/high-agency-labs/j/CODE", "High Agency Labs"},
		"workable already-cased tenant":       {"https://apply.workable.com/DeliveryHero/j/CODE", "DeliveryHero"},
		"smartrecruiters posting":             {"https://jobs.smartrecruiters.com/Visa/744000-role-slug", "Visa"},
		"ashby posting":                       {"https://jobs.ashbyhq.com/openai/uuid-here", "Openai"},
		"greenhouse posting":                  {"https://boards.greenhouse.io/anthropic/jobs/12345", "Anthropic"},
		"lever posting":                       {"https://jobs.lever.co/deepgram/some-id", "Deepgram"},

		// non-slug_in_path providers → return "" honestly instead of guessing
		// the wrong label from subdomain heuristics.
		"eightfold (subdomain tenant, no path)":       {"https://bostonscientific.eightfold.ai/careers/job/123", ""},
		"workday (pod, not company, in subdomain)":    {"https://wd5.myworkdayjobs.com/en-US/Careers/…", ""},
		"internal ATS (careers.foo.com)":              {"https://careers.acme.com/positions/eng", ""},
		"google-careers (fixed subdomain)":            {"https://www.google.com/about/careers/applications/jobs/123", ""},

		// unregistered hosts → empty
		"totally unregistered":                {"https://example.com/jobs/1", ""},
		"malformed URL":                       {"not a url", ""},
		"empty URL":                           {"", ""},
	}
	for name, tc := range cases {
		if got := companyFromURL(tc.url); got != tc.want {
			t.Errorf("%s: companyFromURL(%q) = %q, want %q", name, tc.url, got, tc.want)
		}
	}
}
