package models

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

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

// Every field of a replacing update is either required or has a meaning when
// left out. A field added to the struct and to neither list would be filled
// with a default on every PUT that predates it.
func TestEveryUpdateFieldIsClassified(t *testing.T) {
	var fields []string
	var collect func(reflect.Type)
	collect = func(kind reflect.Type) {
		for i := range kind.NumField() {
			field := kind.Field(i)
			if field.Anonymous {
				collect(field.Type)
				continue
			}
			name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
			if name != "" && name != "-" {
				fields = append(fields, name)
			}
		}
	}
	collect(reflect.TypeFor[UpstreamUpdate]())

	classified := slices.Concat(upstreamUpdateRequired, upstreamUpdateOptional)
	slices.Sort(fields)
	slices.Sort(classified)
	if !slices.Equal(fields, classified) {
		t.Errorf("fields %v, classified %v", fields, classified)
	}
}

// jsonFields lists a struct's json names, embedded structs flattened.
func jsonFields(kind reflect.Type) []string {
	var fields []string
	for i := range kind.NumField() {
		field := kind.Field(i)
		if field.Anonymous {
			fields = append(fields, jsonFields(field.Type)...)
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name != "" && name != "-" {
			fields = append(fields, name)
		}
	}
	return fields
}

// Every field of a token edit is either required or has a meaning when left
// out, for the same reason as a channel's.
func TestEveryTokenUpdateFieldIsClassified(t *testing.T) {
	fields := jsonFields(reflect.TypeFor[APITokenUpdateIn]())
	classified := slices.Concat(tokenUpdateRequired, tokenUpdateOptional)
	slices.Sort(fields)
	slices.Sort(classified)
	if !slices.Equal(fields, classified) {
		t.Errorf("fields %v, classified %v", fields, classified)
	}
}

func TestMissingTokenFieldsAcceptsNullOnlyWhereItMeansSomething(t *testing.T) {
	body := map[string]json.RawMessage{}
	for _, name := range tokenUpdateRequired {
		body[name] = json.RawMessage(`null`)
	}
	missing := MissingTokenFields(body)
	for _, name := range []string{"expires_at", "rate_limit"} {
		if slices.Contains(missing, name) {
			t.Errorf("%s may be null", name)
		}
	}
	for _, name := range []string{"group_id", "allowed_models", "name"} {
		if !slices.Contains(missing, name) {
			t.Errorf("a null %s was accepted", name)
		}
	}
}

func TestMissingUpstreamFieldsCountsNullAsMissing(t *testing.T) {
	body := map[string]json.RawMessage{}
	for _, name := range upstreamUpdateRequired {
		body[name] = json.RawMessage(`[]`)
	}
	if missing := MissingUpstreamFields(body); len(missing) != 0 {
		t.Fatalf("complete body reported missing %v", missing)
	}

	delete(body, "enabled")
	body["priority"] = json.RawMessage(`null`)
	body["rate_limit"] = json.RawMessage(`null`)
	if missing := MissingUpstreamFields(body); !slices.Equal(missing, []string{"priority", "enabled"}) {
		t.Errorf("missing = %v, want [priority enabled]: rate_limit may be null", missing)
	}
}
