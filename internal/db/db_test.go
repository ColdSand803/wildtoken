package db

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// memoryDB returns an initialized in-memory database. A shared cache keeps the
// single logical database alive across pooled connections.
func memoryDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+t.Name()+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if err := Init(context.Background(), db); err != nil {
		t.Fatalf("init: %v", err)
	}
	return db
}

func TestInitIsIdempotent(t *testing.T) {
	db := memoryDB(t)
	if err := Init(context.Background(), db); err != nil {
		t.Fatalf("second init: %v", err)
	}

	for _, table := range []string{
		"upstreams", "api_tokens", "request_logs", "request_log_payloads",
		"runtime_settings", "admin_credential", "model_test_templates",
		"model_test_prompt_templates",
	} {
		var count int64
		err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table).
			Scan(&count)
		if err != nil {
			t.Fatalf("lookup %s: %v", table, err)
		}
		if count != 1 {
			t.Errorf("table %s was not created", table)
		}
	}
}

func TestSeededDefaultsMatchTheRustSchema(t *testing.T) {
	db := memoryDB(t)

	var settings models.RuntimeSettings
	var ok bool
	var err error
	if settings, ok, err = LoadRuntimeSettings(context.Background(), db); err != nil || !ok {
		t.Fatalf("load runtime settings: %v (ok=%v)", err, ok)
	}
	if settings.LogBodyKeepCount != 100 || settings.LogRetentionDays != 30 ||
		settings.LogBodyMaxBytes != 200000 || settings.Revision != 1 {
		t.Errorf("unexpected seeded runtime settings: %+v", settings)
	}

	templates, err := ListModelTestTemplates(context.Background(), db)
	if err != nil {
		t.Fatalf("list templates: %v", err)
	}
	kinds := map[string]string{}
	for _, template := range templates {
		kinds[template.Name] = template.RequestKind
	}
	for name, kind := range map[string]string{
		"codex-tui": "responses", "opencode": "chat_completions", "claude-cli": "messages",
	} {
		if kinds[name] != kind {
			t.Errorf("template %s has kind %q, want %q", name, kinds[name], kind)
		}
	}

	prompts, err := ListModelTestPromptTemplates(context.Background(), db)
	if err != nil {
		t.Fatalf("list prompt templates: %v", err)
	}
	if len(prompts) != 10 {
		t.Errorf("seeded %d prompt templates, want 10", len(prompts))
	}
}

func TestUpdateRuntimeSettingsUsesRevisionCompareAndSwap(t *testing.T) {
	db := memoryDB(t)
	input := models.RuntimeSettingsIn{
		LogBodyKeepCount:                  99,
		LogRetentionDays:                  30,
		LogBodyMaxBytes:                   200000,
		MaxRetries:                        2,
		SameUpstreamRetryIntervalMs:       2500,
		AutoWeightFailurePenalty:          25,
		AutoWeightSuccessIncrement:        8,
		AutoWeightRecoveryIncrement:       12,
		AutoWeightRecoveryIntervalSeconds: 90,
		Revision:                          1,
	}

	updated, err := UpdateRuntimeSettings(context.Background(), db, &input)
	if err != nil {
		t.Fatalf("first update: %v", err)
	}
	if updated.Revision != 2 || updated.MaxRetries != 2 ||
		updated.SameUpstreamRetryIntervalMs != 2500 ||
		updated.AutoWeightFailurePenalty != 25 ||
		updated.AutoWeightSuccessIncrement != 8 ||
		updated.AutoWeightRecoveryIncrement != 12 ||
		updated.AutoWeightRecoveryIntervalSeconds != 90 {
		t.Errorf("unexpected updated settings: %+v", updated)
	}

	// Replaying the same revision must lose the compare-and-swap.
	if _, err := UpdateRuntimeSettings(context.Background(), db, &input); err == nil {
		t.Error("stale revision was accepted")
	}
}

func TestCredentialBootstrapPreservesExistingAndRotationIncrementsVersion(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()

	first, err := BootstrapAdminCredential(ctx, db, "existing-hash")
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if first.CredentialVersion != 1 {
		t.Errorf("first version = %d, want 1", first.CredentialVersion)
	}

	again, err := BootstrapAdminCredential(ctx, db, "replacement-bootstrap-hash")
	if err != nil {
		t.Fatalf("second bootstrap: %v", err)
	}
	if again.CredentialHash != "existing-hash" {
		t.Errorf("bootstrap overwrote an existing credential: %q", again.CredentialHash)
	}

	rotated, ok, err := RotateAdminCredential(ctx, db, "rotated-hash", 1)
	if err != nil || !ok {
		t.Fatalf("rotate: %v (ok=%v)", err, ok)
	}
	if rotated.CredentialHash != "rotated-hash" || rotated.CredentialVersion != 2 {
		t.Errorf("unexpected rotation result: %+v", rotated)
	}

	// A replayed version is a compare-and-swap miss, not an error.
	if _, ok, err := RotateAdminCredential(ctx, db, "third-hash", 1); err != nil || ok {
		t.Errorf("stale rotation: ok=%v err=%v", ok, err)
	}
}

func TestTokenPreviewNeverContainsAShortTokenInFull(t *testing.T) {
	for _, testCase := range []struct{ token, want string }{
		{"", "…"},
		{"x", "…"},
		{"short", "sh…"},
		{"long-enough-token", "long-eno…"},
	} {
		if got := TokenPreview(testCase.token); got != testCase.want {
			t.Errorf("TokenPreview(%q) = %q, want %q", testCase.token, got, testCase.want)
		}
	}
}

func TestCreationHonorsEnabledAndPersistsOnlyTheDigest(t *testing.T) {
	db := memoryDB(t)
	plaintext := "custom-token-value-1234"

	created, err := CreateToken(context.Background(), db, &models.APITokenIn{
		Name:        " disabled client ",
		Description: " disabled at creation ",
		Token:       &plaintext,
		Enabled:     false,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Token != plaintext {
		t.Errorf("created.Token = %q, want the plaintext once", created.Token)
	}
	if created.Enabled {
		t.Error("enabled=false was not honored")
	}
	if created.Name != "disabled client" {
		t.Errorf("name = %q, want it trimmed", created.Name)
	}

	var storedToken, storedHash, storedPreview string
	var storedEnabled int64
	err = db.QueryRow(
		"SELECT token, token_hash, token_preview, enabled FROM api_tokens WHERE id = ?",
		created.ID).Scan(&storedToken, &storedHash, &storedPreview, &storedEnabled)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	digest := TokenDigest(plaintext)
	if storedToken != digest || storedHash != digest {
		t.Error("plaintext survived the insert")
	}
	if storedPreview == plaintext {
		t.Error("preview stored the token in full")
	}
	if storedEnabled != 0 {
		t.Errorf("stored enabled = %d, want 0", storedEnabled)
	}
}

func TestCreationStoresANormalizedExpiryAndRefusesAPastOne(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()

	never, err := CreateToken(ctx, db, &models.APITokenIn{Name: "never", Enabled: true})
	if err != nil {
		t.Fatalf("create never-expiring: %v", err)
	}
	if never.ExpiresAt != nil {
		t.Errorf("expires_at = %v, want nil", *never.ExpiresAt)
	}

	offset := "2099-01-01T08:00:00+08:00"
	dated, err := CreateToken(ctx, db, &models.APITokenIn{
		Name: "dated", Enabled: true, ExpiresAt: &offset,
	})
	if err != nil {
		t.Fatalf("create dated: %v", err)
	}
	if dated.ExpiresAt == nil || *dated.ExpiresAt != "2099-01-01 00:00:00" {
		t.Errorf("expires_at = %v, want the stored UTC shape", dated.ExpiresAt)
	}

	past := "2000-01-01 00:00:00"
	if _, err := CreateToken(ctx, db, &models.APITokenIn{
		Name: "past", Enabled: true, ExpiresAt: &past,
	}); err == nil {
		t.Error("a past expiry was accepted")
	}
}

func TestUpdatingCanRenewOrClearAnExpiryAndLeavesALapsedOneEditable(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()

	future := "2099-01-01 00:00:00"
	created, err := CreateToken(ctx, db, &models.APITokenIn{
		Name: "client", Enabled: true, ExpiresAt: &future,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Backdate the row the way time would have.
	if _, err := db.Exec(
		"UPDATE api_tokens SET expires_at = '2000-01-01 00:00:00' WHERE id = ?",
		created.ID); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	// Renaming an expired token resends its own past expiry unchanged. That must
	// not be rejected, or the row could never be edited again.
	lapsed := "2000-01-01 00:00:00"
	renamed, err := UpdateToken(ctx, db, created.ID, &models.APITokenUpdateIn{
		Name: "renamed", ExpiresAt: &lapsed,
	})
	if err != nil {
		t.Fatalf("rename with unchanged lapsed expiry: %v", err)
	}
	if renamed.Name != "renamed" || renamed.ExpiresAt == nil || *renamed.ExpiresAt != lapsed {
		t.Errorf("unexpected rename result: %+v", renamed)
	}

	// Moving it to a different past instant is a real change, so it is not.
	otherPast := "2001-01-01 00:00:00"
	if _, err := UpdateToken(ctx, db, created.ID, &models.APITokenUpdateIn{
		Name: "renamed", ExpiresAt: &otherPast,
	}); err == nil {
		t.Error("backdating to a new past expiry was accepted")
	}

	renewal := "2099-06-01 00:00:00"
	renewed, err := UpdateToken(ctx, db, created.ID, &models.APITokenUpdateIn{
		Name: "renamed", ExpiresAt: &renewal,
	})
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if renewed.ExpiresAt == nil || *renewed.ExpiresAt != renewal {
		t.Errorf("expires_at = %v, want %q", renewed.ExpiresAt, renewal)
	}

	// An absent expiry clears it — the update endpoint is a full replacement.
	if _, err := UpdateToken(ctx, db, created.ID, &models.APITokenUpdateIn{
		Name: "renamed",
	}); err != nil {
		t.Fatalf("clear expiry: %v", err)
	}
	cleared, ok, err := GetToken(ctx, db, created.ID)
	if err != nil || !ok {
		t.Fatalf("reload: %v (ok=%v)", err, ok)
	}
	if cleared.ExpiresAt != nil {
		t.Errorf("expires_at = %v, want nil", *cleared.ExpiresAt)
	}
}

func TestUpstreamRoundTripsItsJSONColumns(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()

	input := models.DefaultUpstreamIn()
	input.Name = "primary"
	input.BaseURL = "https://api.example.com"
	input.ModelNames = []string{"gpt-4o", "gpt-4o-mini"}
	input.ModelPrefixes = []string{"gpt-"}
	input.ModelMappings = map[string]string{"alias": "gpt-4o"}
	input.ExtraHeaders = map[string]string{"x-tenant": "acme"}

	created, err := CreateUpstream(ctx, db, &input, 300)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.TimeoutSeconds != 300 {
		t.Errorf("timeout = %v, want the default 300", created.TimeoutSeconds)
	}
	if len(created.ModelNames) != 2 || created.ModelMappings["alias"] != "gpt-4o" ||
		created.ExtraHeaders["x-tenant"] != "acme" {
		t.Errorf("JSON columns did not round-trip: %+v", created)
	}
	if created.APIKeySet {
		t.Error("api_key_set is true for an upstream created without a key")
	}

	// An update without an api_key keeps the stored one; clear_api_key removes it.
	key := "sk-secret"
	update := models.UpstreamUpdate{UpstreamIn: input}
	update.APIKey = &key
	if _, err := UpdateUpstream(ctx, db, created.ID, &update); err != nil {
		t.Fatalf("update with key: %v", err)
	}

	update = models.UpstreamUpdate{UpstreamIn: input}
	kept, err := UpdateUpstream(ctx, db, created.ID, &update)
	if err != nil {
		t.Fatalf("update without key: %v", err)
	}
	if !kept.APIKeySet {
		t.Error("an absent api_key cleared the stored one")
	}

	update = models.UpstreamUpdate{UpstreamIn: input, ClearAPIKey: true}
	cleared, err := UpdateUpstream(ctx, db, created.ID, &update)
	if err != nil {
		t.Fatalf("clear key: %v", err)
	}
	if cleared.APIKeySet {
		t.Error("clear_api_key did not remove the stored key")
	}
}
