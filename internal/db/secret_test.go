package db

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/secret"
)

func mustCipher(t *testing.T, passphrase string) *secret.Cipher {
	t.Helper()
	c, err := secret.New(passphrase)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// useTestSecrets installs a cipher for one test, restoring the previous after.
func useTestSecrets(t *testing.T, c *secret.Cipher) {
	t.Helper()
	previous := secrets.Load()
	UseSecrets(c)
	t.Cleanup(func() { secrets.Store(previous) })
}

func rawColumn(t *testing.T, db *sql.DB, query string, id int64) string {
	t.Helper()
	var value sql.NullString
	if err := db.QueryRow(query, id).Scan(&value); err != nil {
		t.Fatalf("read %q: %v", query, err)
	}
	return value.String
}

func assertSealed(t *testing.T, stored, plain string) {
	t.Helper()
	if !secret.IsSealed(stored) || strings.Contains(stored, plain) {
		t.Errorf("stored %q: want it sealed, without %q", stored, plain)
	}
}

const (
	storedAPIKey  = "SELECT api_key FROM upstreams WHERE id = ?"
	storedKeyList = "SELECT api_key FROM upstream_keys WHERE upstream_id = ?"
	storedToken   = "SELECT token_plain FROM api_tokens WHERE id = ?"
)

func TestCredentialsAreSealedAtRestAndReadBackInTheClear(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()
	useTestSecrets(t, mustCipher(t, "test passphrase"))

	key := "sk-upstream-secret"
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL, input.APIKey = "sealed", "https://api.example.com", &key
	created, err := CreateUpstream(ctx, db, &input)
	if err != nil {
		t.Fatalf("create upstream: %v", err)
	}
	assertSealed(t, rawColumn(t, db, storedAPIKey, created.ID), key)

	// An edit that does not carry the key keeps it.
	update := models.UpstreamUpdate{UpstreamIn: input}
	update.APIKey = nil
	if _, err := UpdateUpstream(ctx, db, created.ID, &update); err != nil {
		t.Fatalf("update upstream: %v", err)
	}
	assertSealed(t, rawColumn(t, db, storedAPIKey, created.ID), key)
	if row, _, err := GetUpstream(ctx, db, created.ID); err != nil || row.APIKey == nil || *row.APIKey != key {
		t.Fatalf("read back %v, %v; want %q", row.APIKey, err, key)
	}

	token, err := CreateToken(ctx, db, &models.APITokenIn{Name: "sealed", Enabled: true})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}
	assertSealed(t, rawColumn(t, db, storedToken, token.ID), token.Token)
	if fetched, _, err := GetToken(ctx, db, token.ID); err != nil || fetched.Token != token.Token {
		t.Fatalf("read back %q, %v; want %q", fetched.Token, err, token.Token)
	}

	replacement := "sk-rotated-by-the-operator-0001"
	if _, err := UpdateToken(ctx, db, token.ID, &models.APITokenUpdateIn{
		Name: "sealed", Token: &replacement,
	}); err != nil {
		t.Fatalf("update token: %v", err)
	}
	assertSealed(t, rawColumn(t, db, storedToken, token.ID), replacement)
}

// Startup seals what was stored in the clear and moves values off the key file
// ENCRYPTION_KEY replaced. A key that cannot open a sealed value changes nothing.
func TestSealingBringsEveryCredentialUnderTheKey(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()

	// A database from before sealing: plaintext in every column, the channel's
	// key both in upstream_keys and in the copy upstreams keeps.
	legacyKey := "sk-legacy"
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL, input.APIKey = "legacy", "https://api.example.com", &legacyKey
	legacy, err := CreateUpstream(ctx, db, &input)
	if err != nil {
		t.Fatal(err)
	}
	token, err := CreateToken(ctx, db, &models.APITokenIn{Name: "legacy", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if sealed, _ := HasSealedSecrets(ctx, db); sealed {
		t.Fatal("plaintext reported as sealed")
	}

	// One more, sealed under the key file.
	keyFile := mustCipher(t, "key file")
	movedKey := "sk-moved"
	input.Name, input.APIKey = "moved", &movedKey
	moved, err := CreateUpstream(ctx, db, &input)
	if err != nil {
		t.Fatal(err)
	}
	sealedMoved, _ := keyFile.Seal(movedKey)
	db.Exec("UPDATE upstreams SET api_key = ? WHERE id = ?", sealedMoved, moved.ID)
	db.Exec("UPDATE upstream_keys SET api_key = ? WHERE upstream_id = ?", sealedMoved, moved.ID)
	if sealed, _ := HasSealedSecrets(ctx, db); !sealed {
		t.Fatal("a sealed value went unreported")
	}

	if _, err := SealSecrets(ctx, db, mustCipher(t, "wrong"), nil); err == nil {
		t.Fatal("a key that opens nothing was accepted")
	}
	if got := rawColumn(t, db, storedAPIKey, legacy.ID); got != legacyKey {
		t.Fatalf("a refused run rewrote %q", got)
	}

	current := mustCipher(t, "ENCRYPTION_KEY")
	report, err := SealSecrets(ctx, db, current, keyFile)
	if err != nil || report != (SealReport{Sealed: 3, Resealed: 2}) {
		t.Fatalf("report %+v, %v; want 3 sealed, 2 resealed", report, err)
	}

	for query, want := range map[string]struct {
		id    int64
		plain string
	}{
		"legacy key":      {legacy.ID, legacyKey},
		"moved key":       {moved.ID, movedKey},
		"legacy key list": {legacy.ID, legacyKey},
		"moved key list":  {moved.ID, movedKey},
		"token value":     {token.ID, token.Token},
	} {
		column := storedAPIKey
		switch {
		case query == "token value":
			column = storedToken
		case strings.HasSuffix(query, "list"):
			column = storedKeyList
		}
		stored := rawColumn(t, db, column, want.id)
		if opened, err := current.Open(stored); err != nil || opened != want.plain {
			t.Errorf("%s: opened %q, %v; want %q", query, opened, err, want.plain)
		}
	}

	if report, err := SealSecrets(ctx, db, current, keyFile); err != nil || report != (SealReport{}) {
		t.Errorf("second run: %+v, %v; want nothing to do", report, err)
	}
}
