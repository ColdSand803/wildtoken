package proxy

import (
	"bytes"
	"encoding/json"
	"sort"
)

// Request bodies are rewritten by splicing bytes, not by decoding and encoding
// them again. Re-encoding sorted the top-level keys, compacted every nested
// value and escaped < > & as < and the like, so a single changed field
// changed the whole body the upstream saw.

// member is one key of a JSON object and the byte range of its value.
type member struct {
	name       string
	start, end int
}

// skipValue lets the decoder walk past a value, still validating it, without
// copying it out.
type skipValue struct{}

func (*skipValue) UnmarshalJSON([]byte) error { return nil }

// objectMembers lists the members of the object body holds, in order and with
// duplicates, and the offset of its closing brace. ok is false unless body is
// exactly one JSON object, whitespace aside — what json.Unmarshal accepts.
//
// Names are compared decoded, so "model" is model here as it is to every
// JSON parser upstream.
func objectMembers(body []byte) (members []member, closing int, ok bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, 0, false
	}

	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, 0, false
		}
		name, isName := token.(string)
		if !isName {
			return nil, 0, false
		}
		afterName := int(decoder.InputOffset())
		if err := decoder.Decode(&skipValue{}); err != nil {
			return nil, 0, false
		}
		end := int(decoder.InputOffset())

		start := valueStart(body, afterName, end)
		if start < 0 {
			return nil, 0, false
		}
		members = append(members, member{name: name, start: start, end: end})
	}

	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, 0, false
	}
	closing = int(decoder.InputOffset()) - 1
	for _, b := range body[closing+1:] {
		if !isJSONSpace(b) {
			return nil, 0, false
		}
	}
	return members, closing, true
}

// valueStart skips the colon and padding between a member's name and its
// value, or returns -1 when they are not there.
func valueStart(body []byte, from, end int) int {
	i := from
	for i < end && isJSONSpace(body[i]) {
		i++
	}
	if i >= end || body[i] != ':' {
		return -1
	}
	i++
	for i < end && isJSONSpace(body[i]) {
		i++
	}
	return i
}

func isJSONSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// jsonEdit replaces body[start:end] with text; start == end inserts.
type jsonEdit struct {
	start, end int
	text       []byte
}

// insertMember adds text, a `"name":value` pair, to the object whose members
// and closing brace are given, all offset by base. It goes after the last
// member, or before the closing brace of an empty object.
func insertMember(base int, members []member, closing int, text string) jsonEdit {
	if len(members) == 0 {
		return jsonEdit{start: base + closing, end: base + closing, text: []byte(text)}
	}
	at := base + members[len(members)-1].end
	return jsonEdit{start: at, end: at, text: []byte("," + text)}
}

// applyEdits returns body with the edits made; with none, body itself. The
// edits must not overlap.
func applyEdits(body []byte, edits []jsonEdit) []byte {
	if len(edits) == 0 {
		return body
	}
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].start < edits[j].start })

	size := len(body)
	for _, edit := range edits {
		size += len(edit.text) - (edit.end - edit.start)
	}
	out := make([]byte, 0, size)
	last := 0
	for _, edit := range edits {
		out = append(out, body[last:edit.start]...)
		out = append(out, edit.text...)
		last = edit.end
	}
	return append(out, body[last:]...)
}
