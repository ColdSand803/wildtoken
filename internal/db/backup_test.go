package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// A backup keeps what cannot be lost — channels, tokens, the log rows — and
// drops the bodies the way retention does, flagged as cleared. It is one
// owner-only file that opens on its own.
func TestABackupKeepsTheDataAndDropsTheBodies(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	key := "sk-backed-up"
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL, input.APIKey = "channel", "https://api.example.com", &key
	if _, err := CreateUpstream(ctx, database, &input); err != nil {
		t.Fatal(err)
	}
	token, err := CreateToken(ctx, database, &models.APITokenIn{Name: "kept", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	logID := storeTestLog(t, database, "-1 minute",
		textSnapshot(`{"h":1}`, strings.Repeat("a body worth dropping ", 500)))

	path := filepath.Join(t.TempDir(), "backup.db")
	if err := Backup(ctx, database, path); err != nil {
		t.Fatalf("backup: %v", err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
			t.Errorf("mode = %v, want 0600", info.Mode().Perm())
		}
	}
	for _, sidecar := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(path + sidecar); !os.IsNotExist(err) {
			t.Errorf("%s left beside the backup", sidecar)
		}
	}

	restored, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()

	if got := countRows(t, restored, "SELECT COUNT(*) FROM upstreams WHERE api_key = ?", key); got != 1 {
		t.Errorf("channels with the key = %d, want 1", got)
	}
	if fetched, ok, err := GetToken(ctx, restored, token.ID); err != nil || !ok || fetched.Token != token.Token {
		t.Errorf("token read back %q, %v, %v", fetched.Token, ok, err)
	}
	if got := countRows(t, restored, "SELECT COUNT(*) FROM request_logs WHERE id = ?", logID); got != 1 {
		t.Errorf("log rows = %d, want 1", got)
	}
	for _, table := range []string{"request_log_bodies", "log_chunks"} {
		if got := countRows(t, restored, "SELECT COUNT(*) FROM "+table); got != 0 {
			t.Errorf("%s has %d rows, want none", table, got)
		}
	}
	if got := countRows(t, restored,
		"SELECT bodies_cleared FROM request_log_snapshots WHERE request_log_id = ?", logID); got != 1 {
		t.Error("the log is not flagged as having its bodies cleared")
	}

	if got := countRows(t, database, "SELECT COUNT(*) FROM request_log_bodies"); got != 1 {
		t.Errorf("the live database lost its bodies: %d left", got)
	}
}

// A backup never writes over a file already there.
func TestABackupDoesNotReplaceAFile(t *testing.T) {
	database := memoryDB(t)
	path := filepath.Join(t.TempDir(), "backup.db")
	os.WriteFile(path, []byte("someone else's"), 0o600)

	if err := Backup(context.Background(), database, path); err == nil {
		t.Fatal("backed up over an existing file")
	}
	if data, _ := os.ReadFile(path); string(data) != "someone else's" {
		t.Error("the existing file was changed")
	}
}
