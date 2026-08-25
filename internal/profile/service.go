package profile

import (
	"context"
	"fmt"
	"strings"

	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// =============================================================================
// Overview import
// =============================================================================

// ImportOverview runs the résumé-to-overview prompt against a Markdown résumé
// and returns candidate overview fields for the browser to review. DB writes
// are the browser's job — this service only sanitizes.
func (s *Service) ImportOverview(ctx context.Context, markdown, outputLanguage string) (ImportedOverview, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return ImportedOverview{}, err
	}
	set := llm.PickPromptSet(importOverviewPrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, strings.TrimSpace(markdown)),
	}
	var out ImportedOverview
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return ImportedOverview{}, err
	}
	return finalizeImportedOverview(out), nil
}

// =============================================================================
// Structured résumé import
// =============================================================================

// ImportResume runs the résumé-to-structured prompt against a Markdown résumé
// and returns a fully-typed structure for the browser to hand to a Typst
// renderer. Nothing hits the database — the caller decides whether to save
// the generated .typ source.
func (s *Service) ImportResume(ctx context.Context, markdown, outputLanguage string) (ResumeStructured, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return ResumeStructured{}, err
	}
	set := llm.PickPromptSet(importResumePrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, strings.TrimSpace(markdown)),
	}
	var out ResumeStructured
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return ResumeStructured{}, err
	}
	return FinalizeImportedResume(out), nil
}

// Sanitize LLM-produced structured resume; drop suspicious text.
func FinalizeImportedResume(out ResumeStructured) ResumeStructured {
	out.Contact = finalizeContact(out.Contact)

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

// FlattenBaseResume returns a lossless text projection with `[N]` index
// anchors so ranker output can point at role/bullet/entry positions.
// Contact excluded. Mirrors flattenBaseResume in
// web/static/js/llm/parse/profile/import-resume.mjs.
func FlattenBaseResume(r ResumeStructured) string {
	var b strings.Builder
	writeln := func(s string) { b.WriteString(s); b.WriteByte('\n') }
	join := func(sep string, parts ...string) string {
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if strings.TrimSpace(p) != "" {
				out = append(out, p)
			}
		}
		return strings.Join(out, sep)
	}

	if len(r.Experience) > 0 {
		writeln("EXPERIENCE")
		for i, role := range r.Experience {
			writeln(fmt.Sprintf("[%d] %s", i, join(" | ", role.Company, role.Title, role.Dates)))
			for j, bl := range role.Bullets {
				text := bl.Description
				if bl.LeadIn != "" {
					text = bl.LeadIn + ": " + bl.Description
				}
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
		if len(sec.entries) == 0 {
			continue
		}
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

// =============================================================================
// Brag entries
// =============================================================================

// GenerateBragTags runs the brag-tag prompt and returns normalized tags.
// outputLanguage selects the locale-specific prompt template; missing locales
// fall back to English.
func (s *Service) GenerateBragTags(ctx context.Context, body, outputLanguage string) ([]string, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return nil, err
	}
	set := llm.PickPromptSet(generateBragTagsPrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, strings.TrimSpace(body)),
	}
	var out BragTagResult
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return nil, err
	}
	return finalizeBragTags(out), nil
}

// ImportBrags runs the résumé-to-brags prompt against a Markdown résumé and
// returns candidate brag entries for the browser to review. The DB writes
// happen in the browser after the user picks which entries to keep.
func (s *Service) ImportBrags(ctx context.Context, markdown, outputLanguage string) ([]ImportedBrag, error) {
	if err := llm.RequireClient(s.client); err != nil {
		return nil, err
	}
	set := llm.PickPromptSet(importBragsPrompts(), outputLanguage)
	prompt := llm.Prompt{
		System: set.System,
		User:   fmt.Sprintf(set.User, strings.TrimSpace(markdown)),
	}
	var out ImportBragsResult
	if err := s.client.GenerateJSON(ctx, prompt, &out); err != nil {
		return nil, err
	}
	return finalizeImportedBrags(out), nil
}

