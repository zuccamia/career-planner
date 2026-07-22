package applications

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type stringList []string

func (l *stringList) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*l = nil
		return nil
	}

	var list []string
	if err := json.Unmarshal(data, &list); err == nil {
		*l = stringList(list)
		return nil
	}

	var single string
	if err := json.Unmarshal(data, &single); err == nil {
		single = strings.TrimSpace(single)
		if single == "" {
			*l = nil
			return nil
		}
		*l = stringList{single}
		return nil
	}

	return fmt.Errorf("decode string list: expected string or []string")
}

// JobDescriptionStructured is the normalized structured representation of one raw job description.
type JobDescriptionStructured struct {
	SchemaVersion  string   `json:"schema_version"`
	CompanyName    string   `json:"company_name"`
	RoleTitle      string   `json:"role_title"`
	RoleLevel      string   `json:"role_level"`
	EmploymentType string   `json:"employment_type"`
	Season         string   `json:"season"`
	Year           int      `json:"year"`
	Locations      stringList `json:"locations"`
	LocationNotes  string   `json:"location_notes"`
	Salary         struct {
		Currency string `json:"currency"`
		Amount   string `json:"amount"`
	} `json:"salary"`
	ApplicationDeadline     string   `json:"application_deadline"`
	MinimumQualifications   stringList `json:"minimum_qualifications"`
	PreferredQualifications stringList `json:"preferred_qualifications"`
	Responsibilities        stringList `json:"responsibilities"`
	Languages               stringList `json:"languages"`
	Skills                  stringList `json:"skills"`
	Domains                 stringList `json:"domains"`
	Requirements            struct {
		TranscriptRequired bool     `json:"transcript_required"`
		WorkAuthorization  string   `json:"work_authorization"`
		Education          stringList `json:"education"`
		Majors             stringList `json:"majors"`
		Availability       stringList `json:"availability"`
	} `json:"requirements"`
	Summary string `json:"summary"`
}

const extractJobDescriptionSystemPrompt = `Extract structured facts from a job posting.
Return one valid JSON object only.
No markdown, code fences, or commentary.
Do not infer unsupported facts.
Use empty string, false, 0, or [] when unknown.
Keep arrays concise and deduplicated.
Use only these normalized values:
- role_level: "intern", "new_grad", "junior", "mid", "senior", "staff", "principal", or ""
- employment_type: "full_time", "part_time", "contract", or ""
- season: "spring", "summer", "fall", "winter", or ""
Rules:
- "Intern" / "Internship" => role_level="intern"
- Never use "intern" or "internship" as employment_type
- "Full-time" => employment_type="full_time"
- "Part-time" => employment_type="part_time"
- "Contract" / "Contractor" => employment_type="contract"
- role_level and employment_type can both be set
- salary.amount must exclude currency, e.g. "98,000-131,000" or "30-40/hour"`

const extractJobDescriptionUserPrompt = `Extract this job posting into exactly one JSON object with these fields:
- schema_version
- company_name
- role_title
- role_level
- employment_type
- season
- year
- locations
- location_notes
- salary { currency, amount }
- application_deadline
- minimum_qualifications
- preferred_qualifications
- responsibilities
- languages
- skills
- domains
- requirements { transcript_required, work_authorization, education, majors, availability }
- summary

Use application metadata only if the posting omits company_name or role_title.

Application company: %s
Application role title: %s
Job posting URL: %s

Raw job description:
%s`

func sanitizeJobDescriptionStructured(result JobDescriptionStructured, application Application) JobDescriptionStructured {
	result.SchemaVersion = "job_description.v1"
	result.CompanyName = strings.TrimSpace(result.CompanyName)
	if result.CompanyName == "" {
		result.CompanyName = strings.TrimSpace(application.CompanyName)
	}
	result.RoleTitle = strings.TrimSpace(result.RoleTitle)
	if result.RoleTitle == "" {
		result.RoleTitle = strings.TrimSpace(application.RoleTitle)
	}
	result.RoleLevel = normalizeRoleLevel(result.RoleLevel)
	if result.RoleLevel == "" {
		result.RoleLevel = inferRoleLevel(application.RoleTitle, application.JobDescriptionRaw, result.RoleTitle, result.Summary, result.LocationNotes, result.ApplicationDeadline, strings.Join(result.MinimumQualifications, " "), strings.Join(result.PreferredQualifications, " "), strings.Join(result.Responsibilities, " "))
	}
	result.EmploymentType = normalizeEmploymentType(result.EmploymentType)
	if result.EmploymentType == "" {
		result.EmploymentType = inferEmploymentType(application.RoleTitle, application.JobDescriptionRaw, result.RoleTitle, result.Summary, result.LocationNotes, result.ApplicationDeadline, strings.Join(result.MinimumQualifications, " "), strings.Join(result.PreferredQualifications, " "), strings.Join(result.Responsibilities, " "))
	}
	result.Season = normalizeSeason(result.Season)
	if result.Year < 0 {
		result.Year = 0
	}
	result.Locations = sanitizeStringList(result.Locations)
	result.LocationNotes = strings.TrimSpace(result.LocationNotes)
	result.Salary.Currency = strings.TrimSpace(strings.ToUpper(result.Salary.Currency))
	result.Salary.Amount = strings.TrimSpace(result.Salary.Amount)
	result.ApplicationDeadline = strings.TrimSpace(result.ApplicationDeadline)
	result.MinimumQualifications = sanitizeStringList(result.MinimumQualifications)
	result.PreferredQualifications = sanitizeStringList(result.PreferredQualifications)
	result.Responsibilities = sanitizeStringList(result.Responsibilities)
	result.Languages = sanitizeStringList(result.Languages)
	result.Skills = sanitizeStringList(result.Skills)
	result.Domains = sanitizeStringList(result.Domains)
	result.Requirements.WorkAuthorization = strings.TrimSpace(result.Requirements.WorkAuthorization)
	result.Requirements.Education = sanitizeStringList(result.Requirements.Education)
	result.Requirements.Majors = sanitizeStringList(result.Requirements.Majors)
	result.Requirements.Availability = sanitizeStringList(result.Requirements.Availability)
	result.Summary = strings.TrimSpace(result.Summary)
	return result
}

func normalizeRoleLevel(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	switch value {
	case "intern", "internship":
		return "intern"
	case "new_grad", "new-grad", "new grad", "graduate", "graduating", "entry_level", "entry-level", "entry level":
		return "new_grad"
	case "junior":
		return "junior"
	case "mid", "mid_level", "mid-level", "mid level":
		return "mid"
	case "senior":
		return "senior"
	case "staff":
		return "staff"
	case "principal":
		return "principal"
	default:
		return ""
	}
}

func normalizeEmploymentType(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	switch value {
	case "full_time", "full-time", "full time":
		return "full_time"
	case "part_time", "part-time", "part time":
		return "part_time"
	case "contract", "contractor":
		return "contract"
	default:
		return ""
	}
}

func inferRoleLevel(values ...string) string {
	combined := strings.ToLower(strings.Join(values, " "))
	switch {
	case strings.Contains(combined, "internship"), strings.Contains(combined, " intern "), strings.HasPrefix(combined, "intern "), strings.HasSuffix(combined, " intern"):
		return "intern"
	case strings.Contains(combined, "new grad"), strings.Contains(combined, "new-grad"), strings.Contains(combined, "new_grad"), strings.Contains(combined, "entry level"), strings.Contains(combined, "entry-level"), strings.Contains(combined, "graduate"):
		return "new_grad"
	case strings.Contains(combined, "junior"):
		return "junior"
	case strings.Contains(combined, "mid level"), strings.Contains(combined, "mid-level"), strings.Contains(combined, "mid_level"):
		return "mid"
	case strings.Contains(combined, "senior"):
		return "senior"
	case strings.Contains(combined, "staff"):
		return "staff"
	case strings.Contains(combined, "principal"):
		return "principal"
	default:
		return ""
	}
}

func inferEmploymentType(values ...string) string {
	combined := strings.ToLower(strings.Join(values, " "))
	switch {
	case strings.Contains(combined, "full-time"), strings.Contains(combined, "full time"), strings.Contains(combined, "full_time"):
		return "full_time"
	case strings.Contains(combined, "part-time"), strings.Contains(combined, "part time"), strings.Contains(combined, "part_time"):
		return "part_time"
	case strings.Contains(combined, "contractor"), strings.Contains(combined, "contract"):
		return "contract"
	default:
		return ""
	}
}

func normalizeSeason(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	switch value {
	case "spring", "summer", "fall", "winter":
		return value
	default:
		return ""
	}
}

func sanitizeStringList(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]string, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; !ok {
			seen[key] = trimmed
		}
	}
	if len(seen) == 0 {
		return nil
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, seen[key])
	}
	return result
}

func formatStructuredJobDescription(input JobDescriptionStructured) string {
	return fmt.Sprintf("%s | %s", input.CompanyName, input.RoleTitle)
}

