package profile

// ResumeStructured is the decoded LLM response for structured-resume
// extraction — the shape the browser hands to a Typst renderer to produce
// a house-format .typ file. Fields the résumé doesn't clearly express are
// left empty rather than invented.
type ResumeStructured struct {
	Contact    ResumeContact         `json:"contact"`
	Summary    string                `json:"summary,omitempty"`
	Education  []ResumeEducation     `json:"education,omitempty"`
	Skills     []ResumeSkillGroup    `json:"skills,omitempty"`
	Experience []ResumeExperience    `json:"experience,omitempty"`
	Projects   []ResumeNamedEntry    `json:"projects,omitempty"`
	Activities []ResumeNamedEntry    `json:"activities,omitempty"`
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
