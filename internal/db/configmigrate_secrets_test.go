package db

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/configpack"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestConfigArchiveEncryptedCredentialsRoundTrip(t *testing.T) {
	ctx := context.Background()
	source := migrationDB(t, "source")
	target := migrationDB(t, "target")
	sourceCipher := mustCipher(t, "source database key")
	targetCipher := mustCipher(t, "target database key")
	useTestSecrets(t, sourceCipher)

	channel := createChannelIn(t, source, "primary", []int64{models.DefaultGroupID})
	wantKeys := []models.ConfigArchiveKey{
		{Name: "paused", APIKey: "sk-paused-archive", Enabled: false},
		{Name: "primary", APIKey: "sk-primary-archive", Enabled: true},
		{Name: "reserve", APIKey: "sk-reserve-archive", Enabled: true},
	}
	if err := replaceUpstreamKeys(ctx, source, channel.ID, archiveKeyInputs(wantKeys)); err != nil {
		t.Fatal(err)
	}
	tokenValue := "sk-client-archive-token"
	if _, err := CreateToken(ctx, source, &models.APITokenIn{
		Name: "client", Token: &tokenValue, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	payload := mustExport(t, source, true)
	if len(payload.Channels) != 1 || payload.Channels[0].Keys == nil ||
		!reflect.DeepEqual(*payload.Channels[0].Keys, wantKeys) {
		t.Fatal("export did not preserve every key's value, name, order and enabled state")
	}
	if payload.Channels[0].APIKey == nil || *payload.Channels[0].APIKey != wantKeys[1].APIKey {
		t.Fatal("legacy field must carry the first enabled key")
	}
	if len(payload.Tokens) != 1 || payload.Tokens[0].Token == nil || *payload.Tokens[0].Token != tokenValue {
		t.Fatal("export must open the stored token rather than export its ciphertext")
	}
	archive, err := configpack.Seal(models.ConfigArchive{
		IncludesSecrets: true, Scopes: models.ConfigScopes,
	}, payload, "archive password")
	if err != nil {
		t.Fatal(err)
	}
	payload, err = configpack.Open(&archive, "archive password")
	if err != nil {
		t.Fatal(err)
	}
	withoutSecrets := mustExport(t, source, false)
	if withoutSecrets.Channels[0].Keys != nil || withoutSecrets.Channels[0].APIKey != nil || withoutSecrets.Tokens[0].Token != nil {
		t.Fatal("an export without secrets must omit all credentials")
	}
	encoded, err := json.Marshal(withoutSecrets)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{tokenValue, wantKeys[0].APIKey, wantKeys[1].APIKey, wantKeys[2].APIKey} {
		if strings.Contains(string(encoded), value) {
			t.Fatal("credential leaked into an export without secrets")
		}
	}

	UseSecrets(targetCipher)
	if response := mustImport(t, target, payload, importOptions()); !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}
	var channelID, tokenID int64
	if err := target.QueryRow("SELECT id FROM upstreams WHERE name = 'primary'").Scan(&channelID); err != nil {
		t.Fatal(err)
	}
	if err := target.QueryRow("SELECT id FROM api_tokens WHERE name = 'client'").Scan(&tokenID); err != nil {
		t.Fatal(err)
	}
	assertCredentials := func(keys []models.ConfigArchiveKey, token string) {
		t.Helper()
		listed, err := ListUpstreamKeyValues(ctx, target, channelID)
		if err != nil || !reflect.DeepEqual(archiveKeys(listed), keys) {
			t.Fatalf("key round trip mismatch: %v", err)
		}
		for _, key := range listed {
			assertSealed(t, rawColumn(t, target, "SELECT api_key FROM upstream_keys WHERE id = ?", key.ID), key.APIKey)
		}
		enabled, err := ListEnabledUpstreamKeys(ctx, target)
		if err != nil {
			t.Fatal(err)
		}
		var wantEnabled []string
		for _, key := range keys {
			if key.Enabled {
				wantEnabled = append(wantEnabled, key.APIKey)
			}
		}
		var gotEnabled []string
		for _, key := range enabled[channelID] {
			gotEnabled = append(gotEnabled, key.APIKey)
		}
		if !reflect.DeepEqual(gotEnabled, wantEnabled) {
			t.Fatal("imported keys are not immediately available to routing")
		}
		mirror := rawColumn(t, target, storedAPIKey, channelID)
		assertSealed(t, mirror, wantEnabled[0])
		if opened, err := targetCipher.Open(mirror); err != nil || opened != wantEnabled[0] {
			t.Fatalf("key mirror does not open with target cipher: %v", err)
		}
		stored := rawColumn(t, target, storedToken, tokenID)
		assertSealed(t, stored, token)
		if opened, err := targetCipher.Open(stored); err != nil || opened != token {
			t.Fatalf("token does not open with target cipher: %v", err)
		}
		if rawColumn(t, target, "SELECT token_hash FROM api_tokens WHERE id = ?", tokenID) != TokenDigest(token) {
			t.Fatal("imported token cannot authenticate with its original value")
		}
	}
	assertCredentials(wantKeys, tokenValue)

	options := importOptions()
	options.OnConflict = models.ConfigConflictOverwrite
	storedBefore := rawColumn(t, target, storedToken, tokenID)
	if response := mustImport(t, target, withoutSecrets, options); !response.Applied {
		t.Fatalf("no-secrets overwrite failed: %+v", response)
	}
	assertCredentials(wantKeys, tokenValue)
	if rawColumn(t, target, storedToken, tokenID) != storedBefore {
		t.Fatal("no-secrets overwrite changed the stored token")
	}

	wantKeys = []models.ConfigArchiveKey{{Name: "replacement", APIKey: "sk-replaced-archive", Enabled: true}}
	payload.Channels[0].Keys = &wantKeys
	tokenValue = "sk-replaced-client-token"
	payload.Tokens[0].Token = &tokenValue
	if response := mustImport(t, target, payload, options); !response.Applied {
		t.Fatalf("credential overwrite failed: %+v", response)
	}
	assertCredentials(wantKeys, tokenValue)

	incomplete := []models.ConfigArchiveKey{{Name: "missing value", Enabled: true}}
	payload.Channels[0].Keys = &incomplete
	if response := mustImport(t, target, payload, options); response.Applied || response.Failed == 0 {
		t.Fatal("an incomplete key archive must be refused")
	}
	assertCredentials(wantKeys, tokenValue)
}

func TestConfigArchiveLegacyKeysAndExplicitEmptyList(t *testing.T) {
	ctx := context.Background()
	source := migrationDB(t, "source")
	createChannelIn(t, source, "legacy", []int64{models.DefaultGroupID})
	payload := mustExport(t, source, true)
	payload.Channels[0].Keys = nil // An older archive only carried api_key.

	useTestSecrets(t, mustCipher(t, "target key for legacy archive"))
	target := migrationDB(t, "target")
	if response := mustImport(t, target, payload, importOptions()); !response.Applied {
		t.Fatalf("legacy import failed: %+v", response)
	}
	keys, err := ListEnabledUpstreamKeys(ctx, target)
	if err != nil || len(keys) != 1 {
		t.Fatalf("legacy import must populate the routable key list: %v", err)
	}
	var channelID int64
	for id, entries := range keys {
		channelID = id
		if len(entries) != 1 || entries[0].APIKey != "sk-legacy" {
			t.Fatal("legacy key was not preserved")
		}
	}
	assertSealed(t, rawColumn(t, target, storedAPIKey, channelID), "sk-legacy")

	options := importOptions()
	options.OnConflict = models.ConfigConflictOverwrite
	empty := []models.ConfigArchiveKey{}
	payload.Channels[0].Keys = &empty
	if response := mustImport(t, target, payload, options); !response.Applied {
		t.Fatalf("explicit key clearing failed: %+v", response)
	}
	if got, err := ListUpstreamKeyValues(ctx, target, channelID); err != nil || len(got) != 0 {
		t.Fatalf("explicit empty key list did not clear the keys: %v", err)
	}
	if rawColumn(t, target, storedAPIKey, channelID) != "" {
		t.Fatal("clearing keys left a stale mirrored credential")
	}
}
