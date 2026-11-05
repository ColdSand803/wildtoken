package app

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/secret"
)

const legacyKey = "sk-stored-in-the-clear"

// legacyDatabase is a file database from before sealing: one channel whose key
// sits in the clear.
func legacyDatabase(t *testing.T) (*sql.DB, config.DatabaseSettings, int64) {
	t.Helper()
	ctx := context.Background()
	t.Cleanup(func() { db.UseSecrets(nil) })

	settings := config.Default().Database
	settings.URL = "sqlite:" + filepath.Join(t.TempDir(), "wildtoken.db") + "?mode=rwc"
	database, err := openDatabase(ctx, settings)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	if err := db.Init(ctx, database); err != nil {
		t.Fatal(err)
	}

	key := legacyKey
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL, input.APIKey = "legacy", "https://api.example.com", &key
	created, err := db.CreateUpstream(ctx, database, &input)
	if err != nil {
		t.Fatal(err)
	}
	return database, settings, created.ID
}

func storedKey(t *testing.T, database *sql.DB, id int64) string {
	t.Helper()
	var stored string
	if err := database.QueryRow("SELECT api_key FROM upstreams WHERE id = ?", id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	return stored
}

func readKey(t *testing.T, database *sql.DB, id int64) string {
	t.Helper()
	row, _, err := db.GetUpstream(context.Background(), database, id)
	if err != nil || row.APIKey == nil {
		t.Fatalf("read key: %v, %v", row.APIKey, err)
	}
	return *row.APIKey
}

func TestAFirstStartMakesAKeyFileAndSealsWhatWasInTheClear(t *testing.T) {
	database, settings, id := legacyDatabase(t)
	ctx := context.Background()

	if err := setUpSecrets(ctx, database, settings); err != nil {
		t.Fatal(err)
	}
	keyPath, _ := secretKeyPath(settings)
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("no key file at %s: %v", keyPath, err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("key file mode = %v, want 0600", info.Mode().Perm())
	}
	if stored := storedKey(t, database, id); !secret.IsSealed(stored) || strings.Contains(stored, legacyKey) {
		t.Errorf("stored %q, want it sealed", stored)
	}

	// A restart reads the same file back.
	if err := setUpSecrets(ctx, database, settings); err != nil {
		t.Fatal(err)
	}
	if got := readKey(t, database, id); got != legacyKey {
		t.Errorf("key = %q, want %q", got, legacyKey)
	}
}

// Setting ENCRYPTION_KEY later moves what the key file sealed over to it; the
// file is then needed only for older backups.
func TestSettingEncryptionKeyLaterMovesTheCredentialsOverToIt(t *testing.T) {
	database, settings, id := legacyDatabase(t)
	ctx := context.Background()
	if err := setUpSecrets(ctx, database, settings); err != nil {
		t.Fatal(err)
	}

	settings.EncryptionKey = "0123456789abcdef0123456789abcdef"
	if err := setUpSecrets(ctx, database, settings); err != nil {
		t.Fatal(err)
	}
	keyPath, _ := secretKeyPath(settings)
	os.Remove(keyPath)

	// Surrounding whitespace is dropped, as faketoken drops it.
	settings.EncryptionKey = " " + settings.EncryptionKey + "\n"
	if err := setUpSecrets(ctx, database, settings); err != nil {
		t.Fatalf("ENCRYPTION_KEY alone: %v", err)
	}
	if got := readKey(t, database, id); got != legacyKey {
		t.Errorf("key = %q, want %q", got, legacyKey)
	}
}

// Without the key that sealed them, startup stops rather than make a new key
// over credentials it could never open again.
func TestSealedCredentialsWithoutTheirKeyStopStartup(t *testing.T) {
	database, settings, id := legacyDatabase(t)
	ctx := context.Background()
	if err := setUpSecrets(ctx, database, settings); err != nil {
		t.Fatal(err)
	}
	keyPath, _ := secretKeyPath(settings)
	os.Remove(keyPath)

	if err := setUpSecrets(ctx, database, settings); err == nil {
		t.Fatal("started without the key file")
	}
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Error("a new key file replaced the lost one")
	}

	settings.EncryptionKey = "not the key that sealed anything"
	if err := setUpSecrets(ctx, database, settings); err == nil {
		t.Fatal("started with the wrong ENCRYPTION_KEY")
	}
	if stored := storedKey(t, database, id); !secret.IsSealed(stored) {
		t.Errorf("a refused start rewrote the key to %q", stored)
	}
}

// The plaintext is gone from the bytes on disk, not only from the column.
// Enough channels to fill several pages: with one, an UPDATE alone happened to
// leave nothing behind, while at 120 a quarter of the keys survived it.
func TestSealingLeavesNoPlaintextInTheDatabaseFiles(t *testing.T) {
	database, settings, _ := legacyDatabase(t)
	ctx := context.Background()
	path := strings.TrimSuffix(strings.TrimPrefix(settings.URL, "sqlite:"), "?mode=rwc")

	keys := []string{legacyKey}
	for i := range 119 {
		key := fmt.Sprintf("sk-channel-%03d-%s", i, strings.Repeat("x", 40))
		keys = append(keys, key)
		input := models.DefaultUpstreamIn()
		input.Name, input.BaseURL, input.APIKey = fmt.Sprintf("channel-%03d", i), "https://api.example.com", &key
		if _, err := db.CreateUpstream(ctx, database, &input); err != nil {
			t.Fatal(err)
		}
	}

	onDisk := func() int {
		var bytes []byte
		for _, name := range []string{path, path + "-wal"} {
			data, _ := os.ReadFile(name)
			bytes = append(bytes, data...)
		}
		found := 0
		for _, key := range keys {
			if strings.Contains(string(bytes), key) {
				found++
			}
		}
		return found
	}
	if onDisk() != len(keys) {
		t.Fatal("the keys are not on disk to begin with; the check below proves nothing")
	}

	if err := setUpSecrets(ctx, database, settings); err != nil {
		t.Fatal(err)
	}
	if found := onDisk(); found > 0 {
		t.Errorf("%d of %d plaintext keys survived sealing on disk", found, len(keys))
	}
}

func TestTheKeyFileSitsBesideTheDatabase(t *testing.T) {
	for url, want := range map[string]string{
		"sqlite:/data/wildtoken.db?mode=rwc": "/data/wildtoken.key",
		"sqlite:wildtoken.db?mode=rwc":       "wildtoken.key",
		"sqlite:file:///data/x.sqlite":       "/data/x.key",
		"sqlite:/data/x.key":                 "/data/x.key.key",
		"sqlite::memory:":                    "",
	} {
		settings := config.Default().Database
		settings.URL = url
		if got, err := secretKeyPath(settings); err != nil || got != want {
			t.Errorf("%s: %q, %v; want %q", url, got, err, want)
		}
	}
}
