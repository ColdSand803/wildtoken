package models

import "testing"

func validUpstreamIn() UpstreamIn {
	input := DefaultUpstreamIn()
	input.Name = "primary"
	input.BaseURL = "https://api.example.com"
	return input
}

// The proxy looks a request's effort up in lower case, so a table written with
// any other casing has to be normalized on the way in or it never matches.
func TestValidateNormalizesEffortMappingKeys(t *testing.T) {
	input := validUpstreamIn()
	input.EffortMappings = map[string]string{"  MAX  ": "  xhigh  "}

	if err := input.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if got := input.EffortMappings["max"]; got != "xhigh" {
		t.Errorf("effort mappings = %v, want max mapped to xhigh", input.EffortMappings)
	}
}

// The console posts the whole table on every save, so a row the operator has
// only half typed must not refuse the rest of the form.
func TestValidateDropsHalfWrittenEffortMappings(t *testing.T) {
	input := validUpstreamIn()
	input.EffortMappings = map[string]string{"max": "xhigh", "high": "", "": "low"}

	if err := input.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if len(input.EffortMappings) != 1 || input.EffortMappings["max"] != "xhigh" {
		t.Errorf("effort mappings = %v, want only the complete entry", input.EffortMappings)
	}
}

func TestValidateRejectsUnusableEffortMappings(t *testing.T) {
	tooMany := map[string]string{}
	for index := range EffortMappingMaxEntries + 1 {
		tooMany[string(rune('a'+index%26))+string(rune('a'+index/26))] = "high"
	}

	for _, testCase := range []struct {
		name     string
		mappings map[string]string
	}{
		{"a value longer than the column expects",
			map[string]string{"max": "0123456789012345678901234567890123"}},
		{"a control character that would not survive the wire",
			map[string]string{"max": "xh\nigh"}},
		{"more entries than any provider has efforts", tooMany},
		{"two keys that normalize to the same effort",
			map[string]string{"MAX": "xhigh", "max": "high"}},
	} {
		input := validUpstreamIn()
		input.EffortMappings = testCase.mappings
		if err := input.Validate(); err == nil {
			t.Errorf("%s was accepted", testCase.name)
		}
	}
}
