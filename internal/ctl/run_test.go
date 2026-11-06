package ctl

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func invoke(t *testing.T, server string, args ...string) (int, string, string) {
	t.Helper()
	var out, err bytes.Buffer
	code := Run(context.Background(), append([]string{"--server", server}, args...), strings.NewReader(""), &out, &err)
	return code, out.String(), err.String()
}

func testAuth(t *testing.T) {
	t.Helper()
	t.Setenv("WILDTOKEN_ADMIN_TOKEN", "unit-admin-key")
	t.Setenv("WILDTOKEN_TOKEN", "unit-downstream-key")
}

func TestCLICredentialsStayOnTheirOwnAPI(t *testing.T) {
	testAuth(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/health":
			if r.Header.Get("x-admin-token") != "" || r.Header.Get("Authorization") != "" {
				t.Error("public request carried credentials")
			}
			w.Write([]byte(`{"status":"ok"}`))
		case "/api/admin/tokens/7":
			if r.Header.Get("x-admin-token") != "unit-admin-key" || r.Header.Get("Authorization") != "" {
				t.Error("wrong admin authentication")
			}
			w.Write([]byte(`{"id":7,"enabled":true,"token":"selected-downstream-key"}`))
		case "/v1/models":
			if r.Header.Get("x-admin-token") != "" || r.Header.Get("Authorization") != "Bearer selected-downstream-key" {
				t.Error("admin credential leaked into downstream request")
			}
			w.Write([]byte(`{"data":[{"id":"model-a"}]}`))
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()
	for _, args := range [][]string{{"health"}, {"tokens", "get", "7"}, {"models", "list", "--token-id", "7"}} {
		code, out, err := invoke(t, server.URL, args...)
		if code != 0 || strings.Contains(out+err, "selected-downstream-key") {
			t.Fatalf("code=%d output=%s err=%s", code, out, err)
		}
	}
}

func TestCLIConfirmationAndDryRunDoNotMutate(t *testing.T) {
	testAuth(t)
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Method != "PATCH" || r.URL.Path != "/api/admin/upstreams/8/enabled" {
			t.Error("wrong action")
		}
		w.Write([]byte(`{"enabled":false}`))
	}))
	defer server.Close()
	if code, _, _ := invoke(t, server.URL, "upstreams", "disable", "8"); code == 0 {
		t.Error("mutation needed no confirmation")
	}
	if code, out, err := invoke(t, server.URL, "upstreams", "disable", "8", "--dry-run"); code != 0 || !strings.Contains(out, `"dry_run": true`) {
		t.Fatalf("dry run: %d %s %s", code, out, err)
	}
	if hits.Load() != 0 {
		t.Fatal("preview contacted mutation API")
	}
	if code, _, err := invoke(t, server.URL, "upstreams", "disable", "8", "--yes"); code != 0 {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatal("confirmed mutation was not executed exactly once")
	}
}

func TestCLIUpdatePreservesGroupsKeysAndDisabledState(t *testing.T) {
	testAuth(t)
	const existing = `{"name":"channel","base_url":"https://example.test","keys":[{"id":11,"name":"a","enabled":true,"cooling_seconds":3}],"model_names":["m"],"model_prefixes":[],"model_mappings":{},"effort_mappings":{},"priority":10,"weight":100,"auto_weight_enabled":true,"enabled":false,"extra_headers":{"Authorization":"Bearer provider-key"},"timeout_seconds":300,"rate_limit":null,"group_ids":[4]}`
	var saved chan map[string]any = make(chan map[string]any, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Write([]byte(existing))
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		saved <- body
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	if code, _, err := invoke(t, server.URL, "upstreams", "update", "1", "--data", `{"priority":200}`, "--yes"); code != 0 {
		t.Fatal(err)
	}
	result := <-saved
	if result["enabled"] != false || result["priority"] != float64(200) || result["group_ids"].([]any)[0] != float64(4) {
		t.Fatalf("existing policy lost: %+v", result)
	}
	keys := result["keys"].([]any)
	if keys[0].(map[string]any)["id"] != float64(11) {
		t.Fatal("key list lost")
	}
	if _, ok := keys[0].(map[string]any)["cooling_seconds"]; ok {
		t.Fatal("read-only key metadata sent back")
	}
	if code, _, err := invoke(t, server.URL, "upstreams", "update", "1", "--data", `{"api_key":"replacement"}`, "--yes"); code != 0 {
		t.Fatal(err)
	}
	result = <-saved
	if _, ok := result["keys"]; ok {
		t.Fatal("existing key list shadows requested legacy API key replacement")
	}
}

func TestCLIWritesSecretToPrivateFileWithoutPrintingIt(t *testing.T) {
	testAuth(t)
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte(`{"id":1,"token":"created-secret","name":"client"}`))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "token.key")
	args := []string{"tokens", "create", "--data", `{"name":"client"}`, "--yes", "--secret-out", path}
	code, out, err := invoke(t, server.URL, args...)
	if code != 0 || strings.Contains(out+err, "created-secret") {
		t.Fatalf("%d %s %s", code, out, err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "created-secret\n" {
		t.Fatalf("secret file=%q", data)
	}
	if code, _, _ := invoke(t, server.URL, args...); code == 0 || hits.Load() != 1 {
		t.Fatal("existing secret output caused a second mutation")
	}
}

func TestCLIHTTPAndBusinessErrorsHaveNonzeroExitCodes(t *testing.T) {
	testAuth(t)
	for _, tc := range []struct {
		status int
		body   string
		args   []string
		code   int
	}{
		{401, `{"error":"unauthorized","token":"hidden"}`, []string{"status"}, 3},
		{500, `{"error":"failed"}`, []string{"status"}, 4},
		{200, `{"failed":1,"items":[]}`, []string{"upstreams", "import", "--data", `{"channels":[]}`, "--yes"}, 1},
		{200, `{"ok":false}`, []string{"upstreams", "test", "1", "--yes"}, 1},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
		code, out, err := invoke(t, server.URL, tc.args...)
		server.Close()
		if code != tc.code || strings.Contains(out+err, `"hidden"`) {
			t.Errorf("code=%d want=%d out=%s err=%s", code, tc.code, out, err)
		}
	}
}

func TestCLILogStreamUsesRedactedNDJSON(t *testing.T) {
	testAuth(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: log\ndata: {\"id\":1,\"token\":\"hidden-key\"}\n\n"))
	}))
	defer server.Close()
	code, out, err := invoke(t, server.URL, "logs", "stream")
	if code != 0 || !json.Valid([]byte(out)) || strings.Contains(out, "hidden-key") {
		t.Fatalf("%d %s %s", code, out, err)
	}
}
