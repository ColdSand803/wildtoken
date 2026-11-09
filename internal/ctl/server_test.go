package ctl

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/app"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
)

func TestCLIManagesAnIsolatedRealServer(t *testing.T) {
	settings := config.Default()
	settings.Server.Port = 0
	settings.Database.URL = "sqlite:" + filepath.Join(t.TempDir(), "gateway.db")
	settings.Admin.Token = "isolated-admin-credential-12345678"
	settings.Backup.Dir = ""
	settings.Images.Dir = ""
	ctx, cancel := context.WithCancel(context.Background())
	server, err := app.NewWithSettings(ctx, settings)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
		db.UseSecrets(nil)
	})
	t.Setenv("WILDTOKEN_ADMIN_TOKEN", settings.Admin.Token)
	base := strings.TrimSuffix(server.Ready.AdminURL, "/console")
	call := func(args ...string) map[string]any {
		t.Helper()
		code, out, err := invoke(t, base, args...)
		if code != 0 {
			t.Fatalf("%v: code=%d out=%s err=%s", args, code, out, err)
		}
		var result map[string]any
		if err := json.Unmarshal([]byte(out), &result); err != nil {
			t.Fatalf("decode result: %v", err)
		}
		return result
	}
	group := call("groups", "create", "--data", `{"name":"cli-group","description":"test"}`, "--yes")
	groupID := fmt.Sprint(group["id"])
	channel := call("upstreams", "create", "--data", fmt.Sprintf(`{"name":"cli-channel","base_url":"https://example.test","api_key":"fake-provider-key","model_names":["cli-model"],"group_ids":[%s]}`, groupID), "--yes")
	channelID := fmt.Sprint(channel["id"])
	updated := call("upstreams", "update", channelID, "--data", `{"priority":123}`, "--yes")
	if updated["priority"] != float64(123) || updated["api_key_set"] != true {
		t.Fatalf("update lost fields: %+v", updated)
	}
	secretPath := filepath.Join(t.TempDir(), "downstream.key")
	token := call("tokens", "create", "--data", fmt.Sprintf(`{"name":"cli-token","group_id":%s,"allowed_models":["cli-model"]}`, groupID), "--yes", "--secret-out", secretPath)
	if token["token"] != "[redacted]" {
		t.Fatal("created token printed in clear")
	}
	tokenID := fmt.Sprint(token["id"])
	models := call("models", "list", "--token-id", tokenID)
	if len(models["data"].([]any)) != 1 {
		t.Fatalf("model list=%+v", models)
	}
	token = call("tokens", "update", tokenID, "--data", `{"description":"changed"}`, "--yes")
	if token["group_id"] != group["id"] || len(token["allowed_models"].([]any)) != 1 {
		t.Fatal("token update lost restrictions")
	}
	runtime := call("settings", "update", "--data", `{"max_retries":2}`, "--yes")
	if runtime["max_retries"] != float64(2) || runtime["revision"] != float64(2) {
		t.Fatal("settings revision not carried")
	}
	call("tokens", "disable", tokenID, "--yes")
	if code, _, _ := invoke(t, base, "models", "list", "--token-file", secretPath); code != 3 {
		t.Fatalf("disabled token exit=%d", code)
	}
}
