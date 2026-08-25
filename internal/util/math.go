package util

import "math"

// ---- numeric clamps ----

// Clamp01 clamps raw into the closed interval [0, 1]. NaN and negative values
// collapse to 0; values above 1 collapse to 1.
func Clamp01(raw float64) float64 {
	switch {
	case math.IsNaN(raw), raw < 0:
		return 0
	case raw > 1:
		return 1
	default:
		return raw
	}
}

// NonNegIntPtr returns p unchanged when it points at a non-negative value;
// nil (or a pointer to a negative int) collapses to nil so downstream JSON
// serialization drops the field.
func NonNegIntPtr(p *int) *int {
	if p == nil || *p < 0 {
		return nil
	}
	return p
}
