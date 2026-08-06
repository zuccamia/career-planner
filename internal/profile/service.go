package profile

import (
	"context"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// ExtractFromResume runs the résumé-to-overview prompt against a Markdown
// résumé and returns candidate overview fields for the browser to review.
// DB writes are the browser's job — this service only sanitizes.
func (s *Service) ExtractFromResume(ctx context.Context, markdown, outputLanguage string) (ExtractedOverview, error) {
	prompt := s.BuildExtractFromResumePrompt(markdown, outputLanguage)
	if s.client == nil {
		return ExtractedOverview{}, fmt.Errorf("llm client is not configured")
	}
	var out ExtractedOverview
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return ExtractedOverview{}, err
	}
	return s.FinalizeExtracted(out), nil
}

// BuildExtractFromResumePrompt assembles the prompt for résumé-to-overview
// extraction. The Markdown is passed verbatim (fenced in the prompt template
// as untrusted input).
func (s *Service) BuildExtractFromResumePrompt(markdown, outputLanguage string) llm.Prompt {
	set := llm.PickPromptSet(extractOverviewPrompts, outputLanguage)
	trimmed := strings.TrimSpace(markdown)
	return llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, trimmed),
	}
}

// FinalizeExtracted normalizes decoded overview extraction output: trims all
// string fields, drops suspicious text, dedupes skills and tools case-
// insensitively, and clamps skill fields to the allowed level enum.
func (s *Service) FinalizeExtracted(out ExtractedOverview) ExtractedOverview {
	name := cleanScalar(out.Name)
	headline := cleanScalar(out.Headline)
	summary := cleanScalar(out.Summary)
	environment := cleanScalar(out.Environment)

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
		if raw.Years != nil && *raw.Years > 0 && *raw.Years < 100 {
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

	return ExtractedOverview{
		Name:        name,
		Headline:    headline,
		Summary:     summary,
		Environment: environment,
		Skills:      skills,
		Tools:       tools,
	}
}

// cleanScalar trims whitespace, collapses runs of whitespace to a single space
// for headline-like fields, and rejects strings that llm.IsSuspiciousText
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

// ExtractStructuredResume runs the résumé-to-structured prompt against a
// Markdown résumé and returns a fully-typed structure for the browser to
// hand to a Typst renderer. Nothing hits the database — the caller decides
// whether to save the generated .typ source.
func (s *Service) ExtractStructuredResume(ctx context.Context, markdown, outputLanguage string) (ResumeStructured, error) {
	prompt := s.BuildExtractStructuredResumePrompt(markdown, outputLanguage)
	if s.client == nil {
		return ResumeStructured{}, fmt.Errorf("llm client is not configured")
	}
	var out ResumeStructured
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return ResumeStructured{}, err
	}
	return s.FinalizeStructuredResume(out), nil
}

// BuildExtractStructuredResumePrompt assembles the résumé-to-structured
// prompt. The Markdown is passed verbatim (fenced in the prompt template
// as untrusted input).
func (s *Service) BuildExtractStructuredResumePrompt(markdown, outputLanguage string) llm.Prompt {
	set := llm.PickPromptSet(extractStructuredResumePrompts, outputLanguage)
	trimmed := strings.TrimSpace(markdown)
	return llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, trimmed),
	}
}

// FinalizeStructuredResume trims and sanitises the LLM output. Suspicious
// text (prompt-injection artifacts) is dropped rather than fixed; empty
// slices stay omitted so downstream renderers can skip whole sections.
func (s *Service) FinalizeStructuredResume(out ResumeStructured) ResumeStructured {
	out.Contact = finalizeContact(out.Contact)
	out.Summary = cleanScalar(out.Summary)

	edu := make([]ResumeEducation, 0, len(out.Education))
	for _, e := range out.Education {
		school := cleanScalar(e.School)
		if school == "" {
			continue
		}
		edu = append(edu, ResumeEducation{
			School:   school,
			Location: cleanScalar(e.Location),
			Degree:   cleanScalar(e.Degree),
			Dates:    cleanScalar(e.Dates),
		})
	}
	out.Education = edu

	skills := make([]ResumeSkillGroup, 0, len(out.Skills))
	for _, g := range out.Skills {
		label := cleanScalar(g.Label)
		items := make([]string, 0, len(g.Items))
		for _, it := range g.Items {
			if t := cleanScalar(it); t != "" {
				items = append(items, t)
			}
		}
		if label == "" && len(items) == 0 {
			continue
		}
		skills = append(skills, ResumeSkillGroup{Label: label, Items: items})
	}
	out.Skills = skills

	exp := make([]ResumeExperience, 0, len(out.Experience))
	for _, e := range out.Experience {
		company := cleanScalar(e.Company)
		if company == "" {
			continue
		}
		bullets := make([]ResumeExperienceItem, 0, len(e.Bullets))
		for _, b := range e.Bullets {
			desc := cleanScalar(b.Description)
			lead := cleanScalar(b.LeadIn)
			if desc == "" && lead == "" {
				continue
			}
			bullets = append(bullets, ResumeExperienceItem{LeadIn: lead, Description: desc})
		}
		exp = append(exp, ResumeExperience{
			Company:  company,
			Location: cleanScalar(e.Location),
			Title:    cleanScalar(e.Title),
			Division: cleanScalar(e.Division),
			Dates:    cleanScalar(e.Dates),
			Bullets:  bullets,
		})
	}
	out.Experience = exp

	out.Projects = finalizeNamedEntries(out.Projects)
	out.Activities = finalizeNamedEntries(out.Activities)
	return out
}

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
