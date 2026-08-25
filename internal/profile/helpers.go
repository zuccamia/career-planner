package profile

import (
	"slices"
	"sort"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// ---- import-overview helpers ----

// finalizeImportedOverview normalizes decoded overview output: trims all
// string fields, drops suspicious text, dedupes skills and tools case-
// insensitively, and clamps skill fields to the allowed level enum.
func finalizeImportedOverview(out ImportedOverview) ImportedOverview {
	name := cleanScalar(out.Name)
	headline := cleanScalar(out.Headline)
	summary := cleanScalar(out.Summary)
	workplaceType := cleanScalar(out.WorkplaceType)

	skills := make([]Skill, 0, len(out.Skills))
	seenSkill := map[string]struct{}{}
	for _, raw := range out.Skills {
		name := cleanScalar(raw.Name)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, dup := seenSkill[key]; dup {
			continue
		}
		seenSkill[key] = struct{}{}
		sk := Skill{Name: name}
		if raw.Years != nil && *raw.Years > 0 && *raw.Years <= 50 {
			y := *raw.Years
			sk.Years = &y
		}
		if raw.Level != "" {
			lvl := strings.ToLower(strings.TrimSpace(raw.Level))
			if _, ok := SkillLevels[lvl]; ok {
				sk.Level = lvl
			}
		}
		skills = append(skills, sk)
	}

	tools := make([]string, 0, len(out.Tools))
	seenTool := map[string]struct{}{}
	for _, raw := range out.Tools {
		t := cleanScalar(raw)
		if t == "" {
			continue
		}
		key := strings.ToLower(t)
		if _, dup := seenTool[key]; dup {
			continue
		}
		seenTool[key] = struct{}{}
		tools = append(tools, t)
	}

	return ImportedOverview{
		Name:          name,
		Headline:      headline,
		Summary:       summary,
		WorkplaceType: workplaceType,
		Skills:        skills,
		Tools:         tools,
	}
}

// cleanScalar trims whitespace and rejects strings that llm.IsSuspiciousText
// flags (prompt-injection remnants, etc.).
func cleanScalar(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if llm.IsSuspiciousText(s) {
		return ""
	}
	return s
}

// ---- import-resume helpers ----

func finalizeContact(c ResumeContact) ResumeContact {
	name := cleanScalar(c.Name)
	links := make([]ResumeLink, 0, len(c.Links))
	for _, l := range c.Links {
		url := strings.TrimSpace(l.URL)
		if url == "" || llm.IsSuspiciousText(url) {
			continue
		}
		links = append(links, ResumeLink{Label: cleanScalar(l.Label), URL: url})
	}
	return ResumeContact{
		Name:     name,
		Email:    cleanScalar(c.Email),
		Phone:    cleanScalar(c.Phone),
		Location: cleanScalar(c.Location),
		Links:    links,
	}
}

func finalizeNamedEntries(in []ResumeNamedEntry) []ResumeNamedEntry {
	out := make([]ResumeNamedEntry, 0, len(in))
	for _, e := range in {
		name := cleanScalar(e.Name)
		if name == "" {
			continue
		}
		url := strings.TrimSpace(e.URL)
		if llm.IsSuspiciousText(url) {
			url = ""
		}
		out = append(out, ResumeNamedEntry{
			Name:        name,
			URL:         url,
			Subtitle:    cleanScalar(e.Subtitle),
			Description: cleanScalar(e.Description),
		})
	}
	return out
}

// ---- generate-brag-tags helpers ----

// finalizeBragTags trims, deduplicates, and normalizes decoded tags.
func finalizeBragTags(out BragTagResult) []string {
	seen := map[string]struct{}{}
	tags := make([]string, 0, len(out.Tags))
	for _, raw := range out.Tags {
		tag := strings.ToLower(strings.TrimSpace(raw))
		tag = strings.Join(strings.Fields(tag), " ")
		if llm.IsSuspiciousText(tag) {
			continue
		}
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
		if len(tags) == 7 {
			break
		}
	}
	sort.Strings(tags)
	return tags
}

// ---- import-brags helpers ----

// finalizeImportedBrags normalizes decoded résumé extraction output: trims
// all string fields, drops entries with an empty title, clamps confidence to
// [0, 1], and re-uses finalizeBragTags for per-entry tag cleanup. It also
// deduplicates on a normalized (title, body) key so retries with slight
// variance don't produce visible duplicates in the review UI.
func finalizeImportedBrags(out ImportBragsResult) []ImportedBrag {
	entries := make([]ImportedBrag, 0, len(out.Brags))
	seen := map[string]struct{}{}
	for _, raw := range out.Brags {
		title := strings.TrimSpace(raw.Title)
		body := strings.TrimSpace(raw.Body)
		if title == "" || llm.IsSuspiciousText(title) || llm.IsSuspiciousText(body) {
			continue
		}
		impact := strings.TrimSpace(raw.Impact)
		if llm.IsSuspiciousText(impact) {
			impact = ""
		}
		companyHint := strings.TrimSpace(raw.Company)
		if llm.IsSuspiciousText(companyHint) {
			companyHint = ""
		}
		var entryYear *int
		if raw.EntryYear != nil && *raw.EntryYear >= 1970 && *raw.EntryYear <= 2100 {
			y := *raw.EntryYear
			entryYear = &y
		}
		conf := raw.Confidence
		if conf < 0 {
			conf = 0
		} else if conf > 1 {
			conf = 1
		}
		key := strings.ToLower(strings.Join(strings.Fields(title+" "+body), " "))
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		category := strings.ToLower(strings.TrimSpace(raw.Category))
		if !slices.Contains(BragCategoryOrder, category) {
			category = BragCategory.Experience
		}
		entries = append(entries, ImportedBrag{
			Title:      title,
			Body:       body,
			Impact:     impact,
			Tags:       finalizeBragTags(BragTagResult{Tags: raw.Tags}),
			Company:    companyHint,
			EntryYear:  entryYear,
			Category:   category,
			Confidence: conf,
		})
	}
	return entries
}
