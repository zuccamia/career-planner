package applications

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// flexString accepts a string, bool, or number from JSON and normalizes to a
// string. LLMs sometimes coerce short free-text fields (e.g. work_authorization)
// into a boolean when they intend "yes"/"no".
type flexString string

func (s *flexString) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*s = ""
		return nil
	}
	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		*s = flexString(str)
		return nil
	}
	var b bool
	if err := json.Unmarshal(data, &b); err == nil {
		// A boolean here means the LLM under-specified — the schema expects a
		// descriptive string (e.g. sponsorship / OPT-CPT nuance). Preserve that
		// the posting said *something* while flagging that details are missing;
		// false collapses to empty so the user isn't misled.
		if b {
			*s = "required (details unclear from posting)"
		} else {
			*s = ""
		}
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(data, &n); err == nil {
		*s = flexString(n.String())
		return nil
	}
	return fmt.Errorf("decode flex string: expected string, bool, or number")
}

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
	SchemaVersion  string     `json:"schema_version"`
	CompanyName    string     `json:"company_name"`
	RoleTitle      string     `json:"role_title"`
	RoleLevel      string     `json:"role_level"`
	EmploymentType string     `json:"employment_type"`
	Season         string     `json:"season"`
	Year           int        `json:"year"`
	Locations      stringList `json:"locations"`
	LocationNotes  string     `json:"location_notes"`
	Salary         struct {
		Currency string `json:"currency"`
		Amount   string `json:"amount"`
	} `json:"salary"`
	ApplicationDeadline     string     `json:"application_deadline"`
	MinimumQualifications   stringList `json:"minimum_qualifications"`
	PreferredQualifications stringList `json:"preferred_qualifications"`
	Responsibilities        stringList `json:"responsibilities"`
	Languages               stringList `json:"languages"`
	Skills                  stringList `json:"skills"`
	Domains                 stringList `json:"domains"`
	Requirements            struct {
		TranscriptRequired bool       `json:"transcript_required"`
		WorkAuthorization  flexString `json:"work_authorization"`
		Education          stringList `json:"education"`
		Majors             stringList `json:"majors"`
		Availability       stringList `json:"availability"`
	} `json:"requirements"`
	Summary   string `json:"summary"`
	Reasoning string `json:"reasoning"`
}

// extractionContext carries the fields sanitizeJobDescriptionStructured falls
// back to when the LLM omits them (company/role) or when we need extra text to
// infer level/employment type.
type extractionContext struct {
	CompanyName       string
	RoleTitle         string
	JobDescriptionRaw string
}

func sanitizeJobDescriptionStructured(result JobDescriptionStructured, ctx extractionContext) JobDescriptionStructured {
	result.SchemaVersion = "job_description.v1"
	result.CompanyName = strings.TrimSpace(result.CompanyName)
	if result.CompanyName == "" {
		result.CompanyName = strings.TrimSpace(ctx.CompanyName)
	}
	result.RoleTitle = strings.TrimSpace(result.RoleTitle)
	if result.RoleTitle == "" {
		result.RoleTitle = strings.TrimSpace(ctx.RoleTitle)
	}
	result.RoleLevel = normalizeRoleLevel(result.RoleLevel)
	if result.RoleLevel == "" {
		result.RoleLevel = inferRoleLevel(ctx.RoleTitle, ctx.JobDescriptionRaw, result.RoleTitle, result.Summary, result.LocationNotes, result.ApplicationDeadline, strings.Join(result.MinimumQualifications, " "), strings.Join(result.PreferredQualifications, " "), strings.Join(result.Responsibilities, " "))
	}
	result.EmploymentType = normalizeEmploymentType(result.EmploymentType)
	if result.EmploymentType == "" {
		result.EmploymentType = inferEmploymentType(ctx.RoleTitle, ctx.JobDescriptionRaw, result.RoleTitle, result.Summary, result.LocationNotes, result.ApplicationDeadline, strings.Join(result.MinimumQualifications, " "), strings.Join(result.PreferredQualifications, " "), strings.Join(result.Responsibilities, " "))
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
	result.Requirements.WorkAuthorization = flexString(strings.TrimSpace(string(result.Requirements.WorkAuthorization)))
	result.Requirements.Education = sanitizeEducationList(result.Requirements.Education)
	result.Requirements.Majors = sanitizeStringList(result.Requirements.Majors)
	result.Requirements.Availability = sanitizeStringList(result.Requirements.Availability)
	result.Summary = llm.SanitizeText(result.Summary)
	result.Reasoning = llm.SanitizeText(result.Reasoning)
	return result
}

func normalizeRoleLevel(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	switch value {
	case "intern", "internship":
		return "intern"
	case "new_grad", "new-grad", "new grad", "graduate", "graduating", "fresh graduate", "fresh-grad", "recent graduate", "entry_level", "entry-level", "entry level":
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
	case strings.Contains(combined, "new grad"), strings.Contains(combined, "new-grad"), strings.Contains(combined, "new_grad"), strings.Contains(combined, "fresh graduate"), strings.Contains(combined, "fresh-grad"), strings.Contains(combined, "recent graduate"), strings.Contains(combined, "entry level"), strings.Contains(combined, "entry-level"), strings.Contains(combined, "graduate"):
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

func sanitizeEducationList(values []string) []string {
	values = sanitizeStringList(values)
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		canonical := normalizeEducationLabel(value)
		if canonical == "" {
			canonical = value
		}
		key := strings.ToLower(canonical)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, canonical)
	}
	if len(result) == 0 {
		return nil
	}
	sort.SliceStable(result, func(i, j int) bool { return strings.ToLower(result[i]) < strings.ToLower(result[j]) })
	return result
}

func normalizeEducationLabel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	lower := strings.ToLower(value)
	switch {
	case strings.Contains(lower, "phd"), strings.Contains(lower, "ph.d"), strings.Contains(lower, "doctorate"), strings.Contains(lower, "doctoral"):
		return "PhD"
	case strings.Contains(lower, "mba"):
		return "MBA"
	case strings.Contains(lower, "juris doctor"), strings.Contains(lower, "j.d"), strings.Contains(lower, "jd degree"), lower == "jd":
		return "JD"
	case strings.Contains(lower, "master") || strings.Contains(lower, "m.s") || strings.Contains(lower, "ms degree") || strings.Contains(lower, "m.sc") || strings.Contains(lower, "m.a"):
		return "Master's degree"
	case strings.Contains(lower, "bachelor") || strings.Contains(lower, "b.s") || strings.Contains(lower, "bs degree") || strings.Contains(lower, "b.a"):
		return "Bachelor's degree"
	case strings.Contains(lower, "associate"):
		return "Associate degree"
	case strings.Contains(lower, "high school"), strings.Contains(lower, "secondary school"):
		return "High school diploma"
	default:
		return ""
	}
}
