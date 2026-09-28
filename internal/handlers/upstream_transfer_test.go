package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// adminCall runs one admin handler behind a router that resolves {id}.
func adminCall(t *testing.T, method, pattern, path string, handler http.HandlerFunc,
	body string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	router.Method(method, pattern, handler)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(method, path, strings.NewReader(body)))
	return recorder
}

// A document that leaves fields out gets the defaults a created channel gets,
// not zero values: weight 0, priority 0, disabled, and null model lists the
// console could not render.
func TestImportFillsWhatTheDocumentLeavesOut(t *testing.T) {
	state := upstreamTestState(t)
	response := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"skip","channels":[{"name":"partial","base_url":"https://api.example.com"}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("import returned %d: %s", response.Code, response.Body.String())
	}

	row, found, err := db.GetUpstreamByName(context.Background(), state.DB, "partial")
	if err != nil || !found {
		t.Fatalf("imported channel: found=%v err=%v", found, err)
	}
	if row.Weight != 100 || row.Priority != 100 || row.Enabled != 1 || row.AutoWeightEnabled != 1 {
		t.Errorf("weight=%d priority=%d enabled=%d auto=%d, want the create defaults",
			row.Weight, row.Priority, row.Enabled, row.AutoWeightEnabled)
	}
	if row.ModelNames != "[]" || row.ModelPrefixes != "[]" || row.EffortMappings != "{}" {
		t.Errorf("collections stored as %s / %s / %s, want empty ones",
			row.ModelNames, row.ModelPrefixes, row.EffortMappings)
	}
	if row.TimeoutSeconds != state.EffectiveUpstreamTimeoutSeconds() {
		t.Errorf("timeout = %v, want the service default", row.TimeoutSeconds)
	}
}

// The name is stored trimmed, so it is looked up trimmed: " foo " missed an
// existing "foo" and then collided with it on insert.
func TestImportFindsAnExistingChannelByItsTrimmedName(t *testing.T) {
	state := upstreamTestState(t)
	createChannel(t, state, "foo", "https://api.example.com", 100, nil)

	response := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"skip","channels":[{"name":" foo ","base_url":"https://api.example.com"}]}`)
	var result models.ImportUpstreamsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 || result.Failed != 0 {
		t.Errorf("result = %+v, want the padded name skipped as the existing channel", result)
	}
}

// A key moved into a header is still a key. An export without keys leaves such
// headers out, and importing it over a channel keeps the channel's own, as it
// keeps its API key.
func TestAnExportWithoutKeysLeavesCredentialHeadersOut(t *testing.T) {
	state := upstreamTestState(t)
	input := models.DefaultUpstreamIn()
	input.Name = "secretive"
	input.BaseURL = "https://api.example.com"
	input.ExtraHeaders = map[string]string{"X-Api-Key": "header-secret", "X-Region": "eu"}
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input, 30); err != nil {
		t.Fatal(err)
	}

	exported := adminCall(t, http.MethodPost, "/export", "/export", AdminExportUpstreams(state),
		`{"include_api_keys":false}`)
	if exported.Code != http.StatusOK {
		t.Fatalf("export returned %d: %s", exported.Code, exported.Body.String())
	}
	if strings.Contains(exported.Body.String(), "header-secret") {
		t.Fatalf("an export without keys carries a credential header: %s", exported.Body.String())
	}
	if !strings.Contains(exported.Body.String(), `"X-Region":"eu"`) {
		t.Errorf("an ordinary header was dropped too: %s", exported.Body.String())
	}

	var document struct {
		Channels json.RawMessage `json:"channels"`
	}
	if err := json.Unmarshal(exported.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	imported := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"overwrite","channels":`+string(document.Channels)+`}`)
	if imported.Code != http.StatusOK {
		t.Fatalf("import returned %d: %s", imported.Code, imported.Body.String())
	}

	row, _, err := db.GetUpstreamByName(context.Background(), state.DB, "secretive")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(row.ExtraHeaders, "header-secret") {
		t.Errorf("overwriting from the keyless export removed the credential header: %s",
			row.ExtraHeaders)
	}
}

// A rename onto a taken name is the operator's mistake, answered as creation
// answers it, not as a server failure.
func TestRenamingOntoATakenNameIsABadRequest(t *testing.T) {
	state := upstreamTestState(t)
	createChannel(t, state, "first", "https://api.example.com", 100, nil)
	createChannel(t, state, "second", "https://api.example.com", 100, nil)
	second, _, err := db.GetUpstreamByName(context.Background(), state.DB, "second")
	if err != nil {
		t.Fatal(err)
	}

	path := "/api/admin/upstreams/" + strconv.FormatInt(second.ID, 10)
	response := adminCall(t, http.MethodPut, "/api/admin/upstreams/{id}", path,
		AdminUpdateUpstream(state), `{"name":"first","base_url":"https://api.example.com"}`)
	if response.Code != http.StatusBadRequest {
		t.Errorf("rename onto a taken name returned %d, want 400: %s",
			response.Code, response.Body.String())
	}
}

// The probe sends the key the way the proxy would for the same protocol. As a
// Bearer token it failed a native Anthropic channel that served traffic fine.
func TestAMessagesModelTestSendsTheKeyAsXAPIKey(t *testing.T) {
	state := proxyRateLimitState(t)
	received := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":"hi"}]}`))
	}))
	defer server.Close()

	key := "channel-key"
	input := models.DefaultUpstreamIn()
	input.Name = "anthropic"
	input.BaseURL = server.URL
	input.APIKey = &key
	created, err := db.CreateUpstream(context.Background(), state.DB, &input, 30)
	if err != nil {
		t.Fatal(err)
	}

	path := "/api/admin/upstreams/" + strconv.FormatInt(created.ID, 10) + "/test-model"
	response := adminCall(t, http.MethodPost, "/api/admin/upstreams/{id}/test-model", path,
		AdminTestUpstreamModel(state),
		`{"model":"claude","protocol":"messages","prompt_template_id":0,"prompt":"hi"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("model test returned %d: %s", response.Code, response.Body.String())
	}

	headers := <-received
	if headers.Get("x-api-key") != key || headers.Get("authorization") != "" {
		t.Errorf("probe sent x-api-key=%q authorization=%q, want the key as x-api-key only",
			headers.Get("x-api-key"), headers.Get("authorization"))
	}
}

// A stored zero means "the service default" to the proxy; the probes read it the
// same way instead of as a one-second budget.
func TestAChannelWithoutItsOwnTimeoutIsProbedWithTheDefault(t *testing.T) {
	state := upstreamTestState(t)
	want := time.Duration(state.EffectiveUpstreamTimeoutSeconds() * float64(time.Second))
	if got := probeTimeout(state, 0); got != want {
		t.Errorf("probe timeout for 0 = %v, want the default %v", got, want)
	}
	if got := probeTimeout(state, 12); got != 12*time.Second {
		t.Errorf("probe timeout for 12 = %v, want 12s", got)
	}
}

// The preview dials with the timeout the form holds, bounded like a saved one:
// a huge value overflowed the Duration and timed out at once.
func TestThePreviewRefusesAnOutOfRangeTimeout(t *testing.T) {
	state := upstreamTestState(t)
	response := adminCall(t, http.MethodPost, "/fetch-models", "/fetch-models",
		AdminFetchModelsPreview(state),
		`{"base_url":"https://api.example.com","timeout_seconds":1e12}`)
	if response.Code != http.StatusBadRequest {
		t.Errorf("returned %d, want 400: %s", response.Code, response.Body.String())
	}
}
