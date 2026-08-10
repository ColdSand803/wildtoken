package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func postJSON(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	request.Header.Set("content-type", "application/json")
	return request
}

// TestChannelPayloadsTolerateTheSharedConsoleForm guards the regression that
// broke channel creation: the console serves create and update from one form,
// so it always posts clear_api_key, which only the update payload declares.
func TestChannelPayloadsTolerateTheSharedConsoleForm(t *testing.T) {
	body := `{"name":"ch","base_url":"https://example.test","api_key":"sk-x",
        "model_names":["m"],"model_prefixes":[],"model_mappings":{},
        "priority":100,"weight":100,"auto_weight_enabled":true,"enabled":true,
        "extra_headers":{},"timeout_seconds":300,"clear_api_key":false}`

	// Creation decodes into UpstreamIn, which has no clear_api_key field.
	create := models.DefaultUpstreamIn()
	if err := decodeJSON(postJSON(body), &create); err != nil {
		t.Fatalf("creation rejected the shared form: %v", err)
	}
	if create.Name != "ch" || len(create.ModelNames) != 1 {
		t.Errorf("creation decoded incorrectly: %+v", create)
	}

	// The update payload declares it, and must honor the value.
	update := models.UpstreamUpdate{UpstreamIn: models.DefaultUpstreamIn()}
	if err := decodeJSON(postJSON(strings.Replace(body,
		`"clear_api_key":false`, `"clear_api_key":true`, 1)), &update); err != nil {
		t.Fatalf("update rejected the shared form: %v", err)
	}
	if !update.ClearAPIKey {
		t.Error("clear_api_key was not decoded by the update payload")
	}
}

// TestStrictPayloadsStillRejectUnknownFields keeps the endpoints that the Rust
// original marked deny_unknown_fields from silently accepting a typo.
func TestStrictPayloadsStillRejectUnknownFields(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		body   string
		target func() any
	}{
		{"APITokenIn", `{"name":"t","typo_field":1}`,
			func() any { return &models.APITokenIn{} }},
		{"APITokenUpdateIn", `{"name":"t","typo_field":1}`,
			func() any { return &models.APITokenUpdateIn{} }},
		{"RuntimeSettingsIn", `{"revision":1,"typo_field":1}`,
			func() any { return &models.RuntimeSettingsIn{} }},
		{"AdminTokenRotateIn", `{"token":"x","typo_field":1}`,
			func() any { return &models.AdminTokenRotateIn{} }},
		{"ModelTestTemplateIn", `{"name":"n","typo_field":1}`,
			func() any { return &models.ModelTestTemplateIn{} }},
		{"ModelTestPromptTemplateIn", `{"name":"n","typo_field":1}`,
			func() any { return &models.ModelTestPromptTemplateIn{} }},
		{"ModelTestRequest", `{"model":"m","typo_field":1}`,
			func() any { return &models.ModelTestRequest{} }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if err := decodeStrictJSON(postJSON(testCase.body), testCase.target()); err == nil {
				t.Error("an unknown field was accepted")
			}
			// The same body without the typo must still decode.
			clean := strings.Replace(testCase.body, `,"typo_field":1`, "", 1)
			if err := decodeStrictJSON(postJSON(clean), testCase.target()); err != nil {
				t.Errorf("a well-formed body was rejected: %v", err)
			}
		})
	}
}

// TestLenientPayloadsIgnoreExtraFields documents that the remaining console
// payloads accept a superset, matching the Rust structs that were deliberately
// left without deny_unknown_fields.
func TestLenientPayloadsIgnoreExtraFields(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		body   string
		target func() any
	}{
		{"UpstreamEnabledIn", `{"enabled":true,"extra":1}`,
			func() any { return &models.UpstreamEnabledIn{} }},
		{"UpstreamPriorityIn", `{"priority":10,"extra":1}`,
			func() any { return &models.UpstreamPriorityIn{} }},
		{"ModelFetchIn", `{"base_url":"https://example.test","extra":1}`,
			func() any { return &models.ModelFetchIn{} }},
		{"TestRequest", `{"path":"/v1/models","extra":1}`,
			func() any { return &models.TestRequest{} }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if err := decodeJSON(postJSON(testCase.body), testCase.target()); err != nil {
				t.Errorf("an extra field was rejected: %v", err)
			}
		})
	}
}

// TestDecodedChannelSurvivesARoundTrip checks that a payload the console posts
// back after reading a channel still decodes, which is what the edit dialog does.
func TestDecodedChannelSurvivesARoundTrip(t *testing.T) {
	detail := models.UpstreamDetailOut{
		ID: 1, Name: "ch", BaseURL: "https://example.test",
		ModelNames: []string{"m"}, ModelPrefixes: []string{},
		ModelMappings: map[string]string{}, ExtraHeaders: map[string]string{},
		Priority: 100, Weight: 100, AutoWeightEnabled: true, Enabled: true,
		TimeoutSeconds: 300,
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	update := models.UpstreamUpdate{UpstreamIn: models.DefaultUpstreamIn()}
	if err := decodeJSON(postJSON(string(encoded)), &update); err != nil {
		t.Fatalf("a channel read back from the API did not decode: %v", err)
	}
	if update.Name != "ch" || update.Priority != 100 {
		t.Errorf("round trip lost data: %+v", update)
	}
}
