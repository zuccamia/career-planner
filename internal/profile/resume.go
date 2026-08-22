package profile

import (
	"fmt"
	"strings"
)

// ResumeStructured is the decoded LLM response for structured-resume
// extraction — the shape the browser hands to a Typst renderer.
type ResumeStructured struct {
	Contact    ResumeContact         `json:"contact"`
	Education  []ResumeEducation     `json:"education,omitempty"`
	Skills     []ResumeSkillGroup    `json:"skills,omitempty"`
	Experience []ResumeExperience    `json:"experience,omitempty"`
	Projects   []ResumeNamedEntry    `json:"projects,omitempty"`
	Activities []ResumeNamedEntry    `json:"activities,omitempty"`
}

// Section namespaces the résumé section tokens the tailor pipeline routes
// changes into. Matches ResumeStructured JSON tags.
var Section = struct {
	Experience string
	Projects   string
	Activities string
}{
	Experience: "experience",
	Projects:   "projects",
	Activities: "activities",
}

// ResumeContact is the header block — name plus outward-facing links and
// locale. `Links` holds an ordered list of label/url pairs so callers keep
// the résumé's original presentation order (LinkedIn before GitHub, etc.).
type ResumeContact struct {
	Name     string       `json:"name,omitempty"`
	Email    string       `json:"email,omitempty"`
	Phone    string       `json:"phone,omitempty"`
	Location string       `json:"location,omitempty"`
	Links    []ResumeLink `json:"links,omitempty"`
}

type ResumeLink struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type ResumeEducation struct {
	School   string `json:"school"`
	Location string `json:"location,omitempty"`
	Degree   string `json:"degree,omitempty"`
	Dates    string `json:"dates,omitempty"`
}

// ResumeExperience is one role. `Division` is optional (e.g. the specific
// team within a company); `Bullets` are the per-role achievement items.
type ResumeExperience struct {
	Company  string                 `json:"company"`
	Location string                 `json:"location,omitempty"`
	Title    string                 `json:"title,omitempty"`
	Division string                 `json:"division,omitempty"`
	Dates    string                 `json:"dates,omitempty"`
	Bullets  []ResumeExperienceItem `json:"bullets,omitempty"`
}

// ResumeExperienceItem mirrors the Typst helper `rItem(leadIn, description)`
// — a bold prefix followed by continuation prose.
type ResumeExperienceItem struct {
	LeadIn      string `json:"lead_in,omitempty"`
	Description string `json:"description"`
}

type ResumeSkillGroup struct {
	Label string   `json:"label"`
	Items []string `json:"items"`
}

// ResumeNamedEntry is the shared shape for the Projects and Activities
// sections: a bold name (optionally linked), a subtitle (e.g. "Personal
// Project (2026)"), and a description.
type ResumeNamedEntry struct {
	Name        string `json:"name"`
	URL         string `json:"url,omitempty"`
	Subtitle    string `json:"subtitle,omitempty"`
	Description string `json:"description,omitempty"`
}

// FlattenBaseResume returns a lossless text projection with `[N]` index
// anchors so ranker output can point at role/bullet/entry positions.
// Contact excluded. Mirrors flattenBaseResume in
// web/static/js/llm/parse/extract-structured-resume-from-source.mjs.
func FlattenBaseResume(r ResumeStructured) string {
	var b strings.Builder
	writeln := func(s string) { b.WriteString(s); b.WriteByte('\n') }
	join := func(sep string, parts ...string) string {
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if strings.TrimSpace(p) != "" { out = append(out, p) }
		}
		return strings.Join(out, sep)
	}

	if len(r.Experience) > 0 {
		writeln("EXPERIENCE")
		for i, role := range r.Experience {
			writeln(fmt.Sprintf("[%d] %s", i, join(" | ", role.Company, role.Title, role.Dates)))
			for j, bl := range role.Bullets {
				text := bl.Description
				if bl.LeadIn != "" { text = bl.LeadIn + ": " + bl.Description }
				writeln(fmt.Sprintf("  [%d] %s", j, text))
			}
		}
		writeln("")
	}
	if len(r.Skills) > 0 {
		writeln("SKILLS")
		for _, g := range r.Skills {
			writeln("- " + g.Label + ": " + strings.Join(g.Items, ", "))
		}
		writeln("")
	}
	for _, sec := range []struct {
		label   string
		entries []ResumeNamedEntry
	}{{"PROJECTS", r.Projects}, {"ACTIVITIES", r.Activities}} {
		if len(sec.entries) == 0 { continue }
		writeln(sec.label)
		for i, e := range sec.entries {
			writeln(fmt.Sprintf("[%d] %s", i, join(" — ", e.Name, e.Description)))
		}
		writeln("")
	}
	if len(r.Education) > 0 {
		writeln("EDUCATION")
		for _, ed := range r.Education {
			writeln("- " + join(", ", ed.School, ed.Degree, ed.Dates))
		}
	}
	return strings.TrimSpace(b.String())
}
