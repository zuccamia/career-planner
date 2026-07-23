package applications

import (
	"encoding/json"
	"testing"
)

func TestNormalizeRoleLevelFreshGraduateMapsToNewGrad(t *testing.T) {
	if got := normalizeRoleLevel("Fresh graduate"); got != "new_grad" {
		t.Fatalf("expected new_grad, got %q", got)
	}
}

func TestInferRoleLevelFreshGraduateMapsToNewGrad(t *testing.T) {
	if got := inferRoleLevel("We are hiring a fresh graduate software engineer"); got != "new_grad" {
		t.Fatalf("expected new_grad, got %q", got)
	}
}

func TestJobDescriptionStructuredUnmarshalEducationString(t *testing.T) {
	var result JobDescriptionStructured
	err := json.Unmarshal([]byte(`{"requirements":{"education":"Bachelor's degree in Computer Science"}}`), &result)
	if err != nil {
		t.Fatalf("unmarshal structured job description: %v", err)
	}

	if len(result.Requirements.Education) != 1 || result.Requirements.Education[0] != "Bachelor's degree in Computer Science" {
		t.Fatalf("unexpected education: %#v", result.Requirements.Education)
	}
}

func TestJobDescriptionStructuredUnmarshalEducationArray(t *testing.T) {
	var result JobDescriptionStructured
	err := json.Unmarshal([]byte(`{"requirements":{"education":["Bachelor's degree","Pursuing MS"]}}`), &result)
	if err != nil {
		t.Fatalf("unmarshal structured job description: %v", err)
	}

	if len(result.Requirements.Education) != 2 || result.Requirements.Education[0] != "Bachelor's degree" || result.Requirements.Education[1] != "Pursuing MS" {
		t.Fatalf("unexpected education: %#v", result.Requirements.Education)
	}
}

func TestJobDescriptionStructuredUnmarshalAvailabilityString(t *testing.T) {
	var result JobDescriptionStructured
	err := json.Unmarshal([]byte(`{"requirements":{"availability":"12-week summer internship"}}`), &result)
	if err != nil {
		t.Fatalf("unmarshal structured job description: %v", err)
	}

	if len(result.Requirements.Availability) != 1 || result.Requirements.Availability[0] != "12-week summer internship" {
		t.Fatalf("unexpected availability: %#v", result.Requirements.Availability)
	}
}

func TestJobDescriptionStructuredUnmarshalMajorsString(t *testing.T) {
	var result JobDescriptionStructured
	err := json.Unmarshal([]byte(`{"requirements":{"majors":"Computer Science"}}`), &result)
	if err != nil {
		t.Fatalf("unmarshal structured job description: %v", err)
	}

	if len(result.Requirements.Majors) != 1 || result.Requirements.Majors[0] != "Computer Science" {
		t.Fatalf("unexpected majors: %#v", result.Requirements.Majors)
	}
}

func TestSanitizeEducationListNormalizesVerboseDegreeLabels(t *testing.T) {
	values := sanitizeEducationList([]string{
		"Master's degree program in Computer Science or a related field.",
		"Bachelor of Science in Computer Engineering",
		"PhD in Computer Science",
	})

	if len(values) != 3 {
		t.Fatalf("unexpected education count: %#v", values)
	}
	if values[0] != "Bachelor's degree" || values[1] != "Master's degree" || values[2] != "PhD" {
		t.Fatalf("unexpected normalized education: %#v", values)
	}
}

func TestSanitizeJobDescriptionStructuredNormalizesEducation(t *testing.T) {
	result := sanitizeJobDescriptionStructured(JobDescriptionStructured{}, Application{})
	result = sanitizeJobDescriptionStructured(JobDescriptionStructured{
		Requirements: struct {
			TranscriptRequired bool       `json:"transcript_required"`
			WorkAuthorization  string     `json:"work_authorization"`
			Education          stringList `json:"education"`
			Majors             stringList `json:"majors"`
			Availability       stringList `json:"availability"`
		}{
			Education: stringList{"Master's degree program in Computer Science or a related field."},
		},
	}, Application{})

	if len(result.Requirements.Education) != 1 || result.Requirements.Education[0] != "Master's degree" {
		t.Fatalf("unexpected sanitized education: %#v", result.Requirements.Education)
	}
}