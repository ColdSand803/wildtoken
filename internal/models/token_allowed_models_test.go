package models

import "testing"

func TestModelAllowed(t *testing.T) {
	allowed := []string{"gpt-4o", "claude-*"}
	cases := map[string]bool{
		"gpt-4o":          true,
		"GPT-4o":          true,
		"claude-sonnet-5": true,
		"gpt-4o-mini":     false,
		"o3":              false,
	}
	for model, want := range cases {
		if got := ModelAllowed(allowed, model); got != want {
			t.Errorf("ModelAllowed(%q) = %v, want %v", model, got, want)
		}
	}

	// Empty list means unrestricted.
	if !ModelAllowed(nil, "anything") {
		t.Error("empty allowlist should admit any model")
	}
}

