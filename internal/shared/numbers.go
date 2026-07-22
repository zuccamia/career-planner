package shared

// NonNegativeInt64 clamps negative numbers to zero.
func NonNegativeInt64(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}