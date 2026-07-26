package people

// Person carries the identifying fields other packages need when composing
// LLM prompts (currently just communications, which reads person_name /
// person_notes as thread context). The browser owns person persistence — this
// struct is a wire/argument type, not a stored record.
type Person struct {
	Name  string
	Notes string
}
