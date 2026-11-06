package integration

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/tailscale/hujson"
)

func escapePointer(key string) string {
	return strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
}

func standard(v *hujson.Value) any {
	copy := v.Clone()
	copy.Standardize()
	var value any
	json.Unmarshal(copy.Pack(), &value)
	return value
}

func unambiguous(v *hujson.Value) error {
	switch value := v.Value.(type) {
	case *hujson.Object:
		seen := map[string]bool{}
		for i := range value.Members {
			member := &value.Members[i]
			name := member.Name.Value.(hujson.Literal).String()
			if seen[name] {
				return fmt.Errorf("duplicate configuration key: %s", name)
			}
			seen[name] = true
			if err := unambiguous(&member.Value); err != nil {
				return err
			}
		}
	case *hujson.Array:
		for i := range value.Elements {
			if err := unambiguous(&value.Elements[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

// Merge patches only requested fields. Pi model arrays merge by ID; other
// providers, metadata and JSONC comments remain in the original document.
func Merge(original []byte, desired map[string]any, replace bool) ([]byte, []string, error) {
	if len(original) == 0 {
		original = []byte("{}\n")
	}
	document, err := hujson.Parse(original)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid JSON/JSONC configuration: %w", err)
	}
	if _, ok := document.Value.(*hujson.Object); !ok {
		return nil, nil, fmt.Errorf("configuration root must be an object")
	}
	if err := unambiguous(&document); err != nil {
		return nil, nil, err
	}
	var changes []string
	patch := func(operation, path string, value any) error {
		raw, err := json.Marshal([]map[string]any{{"op": operation, "path": path, "value": value}})
		if err != nil {
			return err
		}
		if err := document.Patch(raw); err != nil {
			return err
		}
		changes = append(changes, path)
		return nil
	}
	var merge func(string, any) error
	merge = func(path string, want any) error {
		current := document.Find(path)
		if current == nil {
			return patch("add", path, want)
		}
		if object, ok := want.(map[string]any); ok {
			if _, ok := current.Value.(*hujson.Object); ok {
				keys := make([]string, 0, len(object))
				for key := range object {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				for _, key := range keys {
					if err := merge(path+"/"+escapePointer(key), object[key]); err != nil {
						return err
					}
				}
				return nil
			}
		}
		if models, ok := want.([]any); ok && strings.HasSuffix(path, "/models") {
			if array, ok := current.Value.(*hujson.Array); ok {
				indices := map[string]int{}
				for i := range array.Elements {
					item, ok := standard(&array.Elements[i]).(map[string]any)
					if !ok {
						return fmt.Errorf("invalid existing model at %s/%d", path, i)
					}
					id, _ := item["id"].(string)
					if _, duplicate := indices[id]; id == "" || duplicate {
						return fmt.Errorf("ambiguous existing model ID at %s", path)
					}
					indices[id] = i
				}
				for _, model := range models {
					item := model.(map[string]any)
					id := item["id"].(string)
					if i, exists := indices[id]; exists {
						if err := merge(path+"/"+strconv.Itoa(i), item); err != nil {
							return err
						}
					} else {
						indices[id] = len(indices)
						if err := patch("add", path+"/-", item); err != nil {
							return err
						}
					}
				}
				return nil
			}
		}
		raw, err := json.Marshal(want)
		if err != nil {
			return err
		}
		var normalized any
		json.Unmarshal(raw, &normalized)
		if reflect.DeepEqual(standard(current), normalized) {
			return nil
		}
		if !replace {
			return fmt.Errorf("configuration conflict at %s; review with --replace before --apply", path)
		}
		return patch("replace", path, want)
	}
	if err := merge("", desired); err != nil {
		return nil, nil, err
	}
	if changes == nil {
		changes = []string{}
	}
	return document.Pack(), changes, nil
}
