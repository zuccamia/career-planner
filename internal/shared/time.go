package shared

import (
	"fmt"
	"time"
)

func ParseRFC3339Nano(value, field string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse %s: %w", field, err)
	}
	return parsed, nil
}

func NowRFC3339Nano() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
