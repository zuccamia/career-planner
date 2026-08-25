// LLM-response-tolerant JSON types. Models occasionally emit a bool or number
// where the schema expects a string, or a single string where a list is
// expected — these types normalize both shapes without failing decode.

package util

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ---- JSON tolerant types ----

// FlexString accepts a string, bool, or number from JSON and normalizes to a
// string. LLMs sometimes coerce short free-text fields (e.g. work_authorization)
// into a boolean when they intend "yes"/"no".
type FlexString string

func (s *FlexString) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*s = ""
		return nil
	}
	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		*s = FlexString(str)
		return nil
	}
	var b bool
	if err := json.Unmarshal(data, &b); err == nil {
		// Bool means under-specified — preserve presence, flag missing details.
		if b {
			*s = "required (details unclear from posting)"
		} else {
			*s = ""
		}
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(data, &n); err == nil {
		*s = FlexString(n.String())
		return nil
	}
	return fmt.Errorf("decode flex string: expected string, bool, or number")
}

// StringList accepts either a JSON array of strings or a single string,
// normalizing both to a []string. An empty single string decodes to nil.
type StringList []string

func (l *StringList) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*l = nil
		return nil
	}

	var list []string
	if err := json.Unmarshal(data, &list); err == nil {
		*l = StringList(list)
		return nil
	}

	var single string
	if err := json.Unmarshal(data, &single); err == nil {
		single = strings.TrimSpace(single)
		if single == "" {
			*l = nil
			return nil
		}
		*l = StringList{single}
		return nil
	}

	return fmt.Errorf("decode string list: expected string or []string")
}
