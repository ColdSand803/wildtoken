package ctl

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCLIBackupDownloadRequiresConsentAndAFile(t *testing.T) {
	testAuth(t)
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "backup.wtbak")
	for _, args := range [][]string{
		{"backup", "create"},
		{"backup", "create", "--yes"},
		{"backup", "create", "--out", path},
	} {
		if code, _, _ := invoke(t, server.URL, args...); code == 0 {
			t.Errorf("backup accepted without consent and destination: %v", args)
		}
	}
	if code, out, err := invoke(t, server.URL, "backup", "create", "--dry-run", "--out", path); code != 0 || !strings.Contains(out, "dry_run") {
		t.Fatalf("backup preview: code=%d out=%s err=%s", code, out, err)
	}
	if hits.Load() != 0 {
		t.Fatal("backup preview or rejected command contacted the server")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("preview created a fake backup: %v", err)
	}
}

func TestCLIBackupDownloadPublishesPrivateBytesWithoutOverwriting(t *testing.T) {
	testAuth(t)
	const backup = "WTBAK\x00private-database-contents"
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Method != "POST" || r.URL.Path != "/api/admin/disaster-recovery/backup" || r.Header.Get("x-admin-token") != "unit-admin-key" || r.Header.Get("Authorization") != "" {
			t.Error("backup requested with wrong route or credentials")
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write([]byte(backup))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "backup.wtbak")
	code, out, errText := invoke(t, server.URL, "backup", "create", "--yes", "--out", path)
	if code != 0 || strings.Contains(out+errText, "private-database-contents") {
		t.Fatalf("backup code=%d out=%s err=%s", code, out, errText)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != backup {
		t.Fatalf("saved backup=%q err=%v", data, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("backup is not private: info=%v err=%v", info, err)
		}
	}
	if code, _, _ := invoke(t, server.URL, "backup", "create", "--yes", "--out", path); code == 0 {
		t.Fatal("existing backup was overwritten")
	}
	if hits.Load() != 1 {
		t.Fatal("existing output triggered another backup request")
	}
}

func TestCLIBackupDownloadDoesNotPublishFailedResponses(t *testing.T) {
	testAuth(t)
	for _, mode := range []string{"http error", "wrong content type", "truncated body"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "http error":
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusInternalServerError)
					w.Write([]byte(`{"error":"backup unavailable"}`))
				case "wrong content type":
					w.Header().Set("Content-Type", "application/json")
					w.Write([]byte(`{"ok":true}`))
				default:
					w.Header().Set("Content-Type", "application/octet-stream")
					w.Header().Set("Content-Length", "100")
					w.Write([]byte("partial"))
				}
			}))
			defer server.Close()
			dir := t.TempDir()
			path := filepath.Join(dir, "backup.wtbak")
			if code, _, _ := invoke(t, server.URL, "backup", "create", "--yes", "--out", path); code == 0 {
				t.Fatal("invalid backup was accepted")
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 0 {
				t.Fatalf("failed download left files: %v err=%v", entries, err)
			}
		})
	}
}

func TestCLIConfigExportRequiresExplicitSecretOutput(t *testing.T) {
	for _, showSecrets := range []bool{false, true} {
		cmd, _, err := resolveCommand([]string{"config", "export"})
		if err != nil {
			t.Fatal(err)
		}
		body, err := prepareBody(cmd, []byte(`{"password":"long-enough-password","include_secrets":true}`), options{showSecrets: showSecrets})
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatal(err)
		}
		if result["include_secrets"] != showSecrets || result["password"] != "long-enough-password" {
			t.Fatalf("export policy changed: %v", result)
		}
	}
}
