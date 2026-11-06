package ctl

import (
	"strings"
	"testing"
)

func TestOutputAliasesAreRejectedBeforeRequests(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := checkOutputs(options{out: "result.json", secretOut: "./result.json"}); err == nil {
		t.Fatal("aliased output files were accepted")
	}
}

func TestOutputRedactsCredentialsWithoutHidingMetadata(t *testing.T) {
	value := map[string]any{
		"token": "private-token", "token_preview": "sk-ab…", "api_key_set": true,
		"extra_headers": map[string]any{"X-Custom-Token": "header-secret", "X-Region": "eu"},
		"proxy_url":     "http://username:password@proxy.test:8080",
	}
	raw, err := encoded(value, options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-token", "header-secret", "username", "password"} {
		if strings.Contains(string(raw), secret) {
			t.Errorf("leaked %s", secret)
		}
	}
	if !strings.Contains(string(raw), `"api_key_set": true`) || !strings.Contains(string(raw), `"X-Region": "eu"`) {
		t.Fatalf("metadata hidden: %s", raw)
	}
}
