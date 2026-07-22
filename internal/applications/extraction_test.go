package applications

import (
	"encoding/json"
	"testing"
)

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