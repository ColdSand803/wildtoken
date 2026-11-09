package ctl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIConfigurationIsPreviewedBeforeItIsApplied(t *testing.T) {
	testAuth(t)
	path := filepath.Join(t.TempDir(), "opencode.jsonc")
	original := "{\n// keep comment\n\"provider\":{\"existing\":{\"options\":{\"apiKey\":\"other-secret\"}}},\n}\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"clients", "opencode", "--protocol", "chat", "--model", "m", "--config", path}
	code, out, err := invoke(t, "http://127.0.0.1:1", args...)
	if code != 0 || strings.Contains(out+err, "other-secret") {
		t.Fatalf("preview=%d %s %s", code, out, err)
	}
	before, _ := os.ReadFile(path)
	if string(before) != original {
		t.Fatal("preview changed configuration")
	}
	code, out, err = invoke(t, "http://127.0.0.1:1", append(args, "--apply", "--yes")...)
	if code != 0 || strings.Contains(out+err, "other-secret") {
		t.Fatalf("apply=%d %s %s", code, out, err)
	}
	after, _ := os.ReadFile(path)
	if !strings.Contains(string(after), "// keep comment") || !strings.Contains(string(after), "other-secret") {
		t.Fatal("existing content lost")
	}
	backups, _ := filepath.Glob(path + ".backup-*")
	if len(backups) != 1 {
		t.Fatalf("backups=%v", backups)
	}
	code, out, err = invoke(t, "http://127.0.0.1:1", append(args, "--apply", "--yes")...)
	if code != 0 || !strings.Contains(out, `"changed_paths": []`) {
		t.Fatalf("repeat=%d %s %s", code, out, err)
	}
}

func TestCLIEmbeddedTokensAreNotPrintedDuringApply(t *testing.T) {
	testAuth(t)
	path := filepath.Join(t.TempDir(), "models.json")
	code, out, err := invoke(t, "http://127.0.0.1:1", "clients", "pi", "--protocol", "responses", "--model", "m", "--config", path, "--embed-token", "--apply", "--yes")
	if code != 0 || strings.Contains(out+err, "unit-downstream-key") || strings.Contains(out+err, "unit-admin-key") {
		t.Fatalf("secret printed: %d %s %s", code, out, err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "unit-downstream-key") || strings.Contains(string(data), "unit-admin-key") {
		t.Fatal("wrong embedded credential")
	}
}

func TestCLISkillInstallIsOfflineIdempotentAndRequiresPermission(t *testing.T) {
	root := filepath.Join(t.TempDir(), "wildtoken")
	args := []string{"skill", "install", "--config", root}
	if code, _, err := invoke(t, "http://127.0.0.1:1", args...); code != 0 {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("skill preview wrote files")
	}
	if code, _, _ := invoke(t, "http://127.0.0.1:1", append(args, "--apply")...); code == 0 {
		t.Fatal("skill write needed no authorization")
	}
	if code, _, err := invoke(t, "http://127.0.0.1:1", append(args, "--apply", "--yes")...); code != 0 {
		t.Fatal(err)
	}
	code, out, err := invoke(t, "http://127.0.0.1:1", append(args, "--apply", "--yes")...)
	if code != 0 || !strings.Contains(out, `"files": []`) {
		t.Fatalf("repeat=%d %s %s", code, out, err)
	}
	path := filepath.Join(root, "SKILL.md")
	if err := os.WriteFile(path, []byte("user skill"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := invoke(t, "http://127.0.0.1:1", append(args, "--apply", "--yes")...); code == 0 {
		t.Fatal("existing skill silently replaced")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "user skill" {
		t.Fatal("existing skill changed")
	}
}
