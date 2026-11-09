package integration

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tailscale/hujson"
)

func generated(t *testing.T, tool, protocol string) map[string]any {
	t.Helper()
	value, err := Generate(Options{Tool: tool, Protocol: protocol, Provider: "wildtoken", Server: "http://localhost:3100", TokenEnv: "MODEL_KEY", Models: []string{"model-a"}})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestProtocolURLsAndCredentialReferencesMatchClients(t *testing.T) {
	for _, tool := range []string{"pi", "opencode"} {
		for _, protocol := range []string{"chat", "responses", "messages"} {
			value := generated(t, tool, protocol)
			raw, _ := json.Marshal(value)
			if tool == "pi" {
				provider := value["providers"].(map[string]any)["wildtoken"].(map[string]any)
				want := "http://localhost:3100/v1"
				if protocol == "messages" {
					want = "http://localhost:3100"
				}
				if provider["baseUrl"] != want || provider["apiKey"] != "$MODEL_KEY" {
					t.Fatalf("wrong Pi provider: %s", raw)
				}
			} else {
				provider := value["provider"].(map[string]any)["wildtoken"].(map[string]any)
				options := provider["options"].(map[string]any)
				if options["baseURL"] != "http://localhost:3100/v1" || options["apiKey"] != "{env:MODEL_KEY}" {
					t.Fatalf("wrong OpenCode provider: %s", raw)
				}
				npm := map[string]string{"chat": "@ai-sdk/openai-compatible", "responses": "@ai-sdk/openai", "messages": "@ai-sdk/anthropic"}[protocol]
				if provider["npm"] != npm {
					t.Fatalf("wrong transport: %s", raw)
				}
			}
		}
	}
}

func TestUnknownCapabilitiesAreNotInvented(t *testing.T) {
	raw, _ := json.Marshal(generated(t, "pi", "chat"))
	for _, field := range []string{"contextWindow", "maxTokens", "cost", "reasoning", "input"} {
		if strings.Contains(string(raw), `"`+field+`"`) {
			t.Errorf("invented %s", field)
		}
	}
}

func TestGeneratedStringsCannotExecuteCredentialCommands(t *testing.T) {
	o := Options{Tool: "pi", Protocol: "chat", Provider: "wildtoken", Server: "http://localhost:3100", TokenEnv: "KEY", Models: []string{"m"}, EmbedToken: true, Token: "!command-$SECRET"}
	value, err := Generate(o)
	if err != nil {
		t.Fatal(err)
	}
	key := value["providers"].(map[string]any)["wildtoken"].(map[string]any)["apiKey"]
	if key != "$!command-$$SECRET" {
		t.Fatalf("Pi key not escaped: %v", key)
	}
	o.Tool, o.Token = "opencode", "{file:~/.private}"
	if _, err := Generate(o); err == nil {
		t.Error("literal token became file interpolation")
	}
	o.EmbedToken, o.Models = false, []string{"{env:SECRET}"}
	if _, err := Generate(o); err == nil {
		t.Error("model ID became environment interpolation")
	}
}

func TestJSONCMergePreservesCommentsProvidersAndExistingModels(t *testing.T) {
	original := []byte(`{
 // user-owned comment
 "theme": "dark",
 "providers": {
   "existing": {"baseUrl":"https://existing.test"},
   "wildtoken": { // provider comment
      "baseUrl":"http://localhost:3100/v1", "api":"openai-completions", "apiKey":"$MODEL_KEY",
      "models": [{"id":"old","contextWindow":8192}, {"id":"model-a","name":"My name"}],
   },
 },
}`)
	desired := generated(t, "pi", "chat")
	next, changes, err := Merge(original, desired, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 0 || string(next) != string(original) {
		t.Fatalf("no-op changed existing bytes: %s", next)
	}
	desired["providers"].(map[string]any)["wildtoken"].(map[string]any)["models"] = []any{map[string]any{"id": "new"}}
	next, changes, err = Merge(original, desired, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, keep := range []string{"// user-owned comment", "// provider comment", `"theme": "dark"`, `"id":"old"`, `"name":"My name"`, "https://existing.test"} {
		if !strings.Contains(string(next), keep) {
			t.Errorf("lost %q: %s", keep, next)
		}
	}
	if len(changes) != 1 {
		t.Fatalf("changes=%v", changes)
	}
	again, changes, err := Merge(next, desired, false)
	if err != nil || len(changes) != 0 || string(again) != string(next) {
		t.Fatal("second merge was not a no-op")
	}
}

func TestConfigConflictsRequireReplacementAndDuplicateKeysAreRefused(t *testing.T) {
	original := []byte(`{"providers":{"wildtoken":{"api":"other"}}}`)
	desired := generated(t, "pi", "chat")
	if _, _, err := Merge(original, desired, false); err == nil {
		t.Fatal("conflict overwritten without permission")
	}
	next, _, err := Merge(original, desired, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hujson.Parse(next); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`[]`, `{"providers":{},"providers":{}}`, `{"providers":{"wildtoken":{"models":[{"id":"a"},{"id":"a"}]}}}`} {
		if _, _, err := Merge([]byte(raw), desired, true); err == nil {
			t.Errorf("ambiguous config accepted: %s", raw)
		}
	}
}
