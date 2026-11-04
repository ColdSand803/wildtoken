package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func checkPrepared(t *testing.T, label, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s:\n got %s\nwant %s", label, got, want)
	}
	if !json.Valid([]byte(got)) {
		t.Errorf("%s: invalid JSON %s", label, got)
	}
}

// Re-encoding sorted the keys, compacted the layout and escaped <b> as
// \u003cb\u003e. Only the three rewritten values may change now.
func TestARewriteLeavesEveryOtherByteAsSent(t *testing.T) {
	body := `{
  "stream": true,
  "model" : "requested",
  "messages": [{"role": "user", "content": "<b>Tom & Jerry</b> \u00e9 ✓"}],
  "zeta": {"b": 1, "a": 2},
  "reasoning": { "summary": "auto", "effort": "max" },
  "stream_options": {"include_obfuscation": false}
}`
	want := strings.NewReplacer(
		`"requested"`, `"forwarded"`,
		`"effort": "max"`, `"effort": "xhigh"`,
		`{"include_obfuscation": false}`, `{"include_obfuscation": false,"include_usage":true}`,
	).Replace(body)

	got := PrepareUpstreamBody([]byte(body), ptrTo("forwarded"), "chat/completions",
		map[string]string{"max": "xhigh"})
	checkPrepared(t, "rewrite", string(got), want)
}

func TestUsageIsAskedForWhateverShapeStreamOptionsTakes(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"absent", `{"model":"m","stream":true}`,
			`{"model":"m","stream":true,"stream_options":{"include_usage":true}}`},
		{"absent, padded", `{"stream":true }`,
			`{"stream":true,"stream_options":{"include_usage":true} }`},
		{"empty", `{"stream":true,"stream_options":{ }}`,
			`{"stream":true,"stream_options":{ "include_usage":true}}`},
		{"false", `{"stream":true,"stream_options":{"include_usage":false}}`,
			`{"stream":true,"stream_options":{"include_usage":true}}`},
		{"null", `{"stream":true,"stream_options":null}`,
			`{"stream":true,"stream_options":{"include_usage":true}}`},
		{"already asked", `{"stream":true,"stream_options":{"include_usage":true}}`,
			`{"stream":true,"stream_options":{"include_usage":true}}`},
		{"last stream wins", `{"stream":true,"stream":false}`,
			`{"stream":true,"stream":false}`},
	} {
		got := PrepareUpstreamBody([]byte(c.body), nil, "chat/completions", nil)
		checkPrepared(t, c.name, string(got), c.want)
	}
}

// Routing reads the last "model", as json.Unmarshal does; an upstream may read
// the first. Both must carry the forwarded name.
func TestEveryDuplicateModelIsRewritten(t *testing.T) {
	got := PrepareUpstreamBody([]byte(`{"model":"cheap","model":"routed"}`),
		ptrTo("routed"), "messages", nil)
	checkPrepared(t, "duplicates", string(got), `{"model":"routed","model":"routed"}`)
}

// Names are matched decoded: "mod\u0065l" is the model to every JSON parser.
func TestAnEscapedMemberNameIsStillTheModel(t *testing.T) {
	got := PrepareUpstreamBody([]byte(`{"mod\u0065l":"requested"}`), ptrTo("forwarded"), "messages", nil)
	checkPrepared(t, "escaped name", string(got), `{"mod\u0065l":"forwarded"}`)
}

func TestABodyThatIsNotOneObjectIsLeftAlone(t *testing.T) {
	for _, body := range []string{
		``, `[{"model":"m"}]`, `"model"`, `{"model":"m"} {}`, `{"model":"m"`, `{"model":"m",}`,
	} {
		if got := PrepareUpstreamBody([]byte(body), ptrTo("forwarded"), "chat/completions",
			map[string]string{"max": "xhigh"}); string(got) != body {
			t.Errorf("%q was rewritten to %q", body, got)
		}
	}
}

// A non-object reasoning holds no effort to rewrite; inventing an object there
// would send a shape the caller never did.
func TestANonObjectEffortParentIsLeftAlone(t *testing.T) {
	body := `{"reasoning":"max","output_config":null}`
	got := PrepareUpstreamBody([]byte(body), nil, "responses", map[string]string{"max": "xhigh"})
	checkPrepared(t, "non-object parent", string(got), body)
}
