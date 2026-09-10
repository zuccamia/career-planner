package applications

import (
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/util"
)

// ---- extract-job-description helpers ----

func suspiciousJDWarning(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || !llm.IsSuspiciousText(trimmed) {
		return ""
	}
	return "Job description text appears to contain prompt-like or internal-instruction language. Results may be less reliable; review extracted fields carefully."
}

// atsFactPairs returns the (label, value) pairs the LLM and re-extract paths
// both surface from an ATS posting. Single source of truth for the field set.
func atsFactPairs(p ats.Posting) [][2]string {
	return [][2]string{
		{"Role title", p.Title},
		{"Company", p.Company},
		{"Location", p.Location},
		{"Department", p.Department},
		{"Team", p.Team},
		{"Compensation", p.Compensation},
		{"Employment type", p.EmploymentType},
	}
}

// formatFactLines renders non-empty pairs as "- label: value" bullets.
func formatFactLines(pairs [][2]string) []string {
	var lines []string
	for _, kv := range pairs {
		if v := strings.TrimSpace(kv[1]); v != "" {
			lines = append(lines, "- "+kv[0]+": "+v)
		}
	}
	return lines
}

// enrichRawWithATSMetadata prepends a "Job details" preamble to the raw
// description so structured ATS facts survive being saved and re-extracted.
func enrichRawWithATSMetadata(p ats.Posting, sourceURL, description string) string {
	var lines []string
	if src := strings.TrimSpace(sourceURL); src != "" {
		sourceLine := "- Source: " + src
		if p.Provider != "" {
			sourceLine += " (via " + p.Provider + ")"
		}
		lines = append(lines, sourceLine)
	}
	lines = append(lines, formatFactLines(atsFactPairs(p))...)
	if len(lines) == 0 {
		return description
	}
	return "Job details:\n" + strings.Join(lines, "\n") + "\n\n" + description
}

// buildATSHintsBlock renders ATS-returned fields as a "known facts" block the
// LLM is told to trust verbatim. Returns "" when the ATS gave us nothing.
func buildATSHintsBlock(p ats.Posting) string {
	lines := formatFactLines(atsFactPairs(p))
	if len(lines) == 0 {
		return ""
	}
	header := "ATS-verified facts"
	if p.Provider != "" && p.Provider != "generic" {
		header = "ATS-verified facts (source: " + p.Provider + ")"
	}
	return "\n" + header + " (use verbatim, do not infer):\n" + strings.Join(lines, "\n") + "\n"
}

// overlayATSPosting prefers ATS-provider fields over LLM-inferred ones for
// title, company, and location.
func overlayATSPosting(structured JobDescriptionStructured, posting ats.Posting) JobDescriptionStructured {
	if title := strings.TrimSpace(posting.Title); title != "" {
		structured.RoleTitle = title
	}
	if company := strings.TrimSpace(posting.Company); company != "" {
		structured.CompanyName = company
	}
	if location := strings.TrimSpace(posting.Location); location != "" && len(structured.Locations) == 0 {
		structured.Locations = []string{location}
	}
	if comp := strings.TrimSpace(posting.Compensation); comp != "" {
		currency, amount := splitCompensation(comp)
		if structured.Salary.Currency == "" {
			structured.Salary.Currency = currency
		}
		if structured.Salary.Amount == "" {
			structured.Salary.Amount = amount
		}
	}
	// EmploymentType from ATS only overrides when the LLM left it blank AND
	// the ATS value maps cleanly to our enum. Unmapped values (e.g. Ashby's
	// INTERN, which we track as role_level instead) fall through to the LLM's
	// inference — the raw ATS value is already in the hints block for context.
	if structured.EmploymentType == "" {
		if et := normalizeEmploymentType(posting.EmploymentType); et != "" {
			structured.EmploymentType = et
		}
	}
	return structured
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
	result.EmploymentType = normalizeEmploymentType(result.EmploymentType)
	if result.RoleLevel == "" || result.EmploymentType == "" {
		haystack := []string{
			ctx.RoleTitle, ctx.JobDescriptionRaw,
			result.RoleTitle, result.Summary, result.LocationNotes, result.ApplicationDeadline,
			strings.Join(result.MinimumQualifications, " "),
			strings.Join(result.PreferredQualifications, " "),
			strings.Join(result.Responsibilities, " "),
		}
		if result.RoleLevel == "" {
			result.RoleLevel = inferRoleLevel(haystack...)
		}
		if result.EmploymentType == "" {
			result.EmploymentType = inferEmploymentType(haystack...)
		}
	}
	result.Function = sanitizeFunctionForPersona(result.Function)
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
	result.Requirements.WorkAuthorization = util.FlexString(strings.TrimSpace(string(result.Requirements.WorkAuthorization)))
	result.Requirements.Education = sanitizeEducationList(result.Requirements.Education)
	result.Requirements.Majors = sanitizeStringList(result.Requirements.Majors)
	result.Requirements.Availability = sanitizeStringList(result.Requirements.Availability)
	result.Summary = llm.SanitizeText(result.Summary)
	result.Reasoning = llm.SanitizeText(result.Reasoning)
	log.Printf("jd extract: role=%q function=%q", result.RoleTitle, result.Function)
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

// Values that trigger the unscoped-persona fallback (checked post-clean).
var emptyFunctionSynonyms = map[string]struct{}{
	"":        {},
	"unknown": {},
	"none":    {},
	"na":      {},
	"other":   {},
	"various": {},
	"general": {},
}

// sanitizeFunctionForPersona lowercases, keeps only [a-z\s-], caps at 50,
// deny-lists common empties. Blunts prompt injection through persona.
func sanitizeFunctionForPersona(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range strings.ToLower(value) {
		switch {
		case r >= 'a' && r <= 'z', r == '-':
			b.WriteRune(r)
		case r == ' ', r == '\t', r == '\n':
			b.WriteRune(' ')
		}
	}
	cleaned := strings.Join(strings.Fields(b.String()), " ")
	if len(cleaned) > 50 {
		cleaned = cleaned[:50]
	}
	if _, empty := emptyFunctionSynonyms[cleaned]; empty {
		return ""
	}
	return cleaned
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

// ---- tailor-with-tools (turn) helpers ----

// Loaded via ToolSchema (not a var) so it resolves at request time, after
// LoadToolSchemas runs at boot — same pattern as the prompt getters.
func tailorToolDefs() []llm.ChatTool {
	return llm.ToolSchema("applications/tailor-with-tools")
}

// Assembles [system, user, ...exchange_pairs] from the request. Server is
// stateless; caller sends the full exchange history each turn.
func assembleTailorTurnMessages(req TailorTurnRequest) ([]llm.ChatMessage, error) {
	set := llm.PickPromptSet(tailorWithToolsPrompts(), req.Input.OutputLanguage)
	profileJSON, err := json.Marshal(req.Input.Profile)
	if err != nil {
		return nil, fmt.Errorf("marshal profile: %w", err)
	}
	baseJSON, err := json.Marshal(req.Input.BaseResumeStructured)
	if err != nil {
		return nil, fmt.Errorf("marshal base resume: %w", err)
	}
	system := buildPersonifiedSystem(set, req.Input.JDStructured)
	user := fmt.Sprintf(set.User,
		bulletWordCap,
		req.Input.RoleSignals,
		req.Input.ProfileFit,
		string(req.Input.JDStructured),
		string(profileJSON),
		string(baseJSON),
	)
	msgs := []llm.ChatMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
	for _, ex := range req.Exchanges {
		msgs = append(msgs, llm.ChatMessage{Role: "assistant", ToolCalls: ex.ToolCalls})
		for _, tr := range ex.ToolResults {
			msgs = append(msgs, llm.ChatMessage{
				Role:       "tool",
				ToolCallID: tr.ID,
				Content:    string(tr.ResultJSON),
			})
		}
	}
	return msgs, nil
}
