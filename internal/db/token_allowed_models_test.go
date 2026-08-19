package db

import (
	"context"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// apiTokensWithoutAllowedModels is the table as it stood before the whitelist
// column, so the migration can be exercised on the shape a deployed database has.
const apiTokensWithoutAllowedModels = `
CREATE TABLE api_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    token       TEXT NOT NULL UNIQUE,
    token_hash  TEXT NOT NULL,
    token_preview TEXT NOT NULL,
    token_plain TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    expires_at  TEXT,
    used_tokens  INTEGER NOT NULL DEFAULT 0,
    limit_tokens INTEGER,
    group_id    INTEGER,
    rate_limit  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`

// TestAllowedModelsMigratesOntoAnOlderDatabase covers the upgrade path, where the
// column is added to a table that already holds credentials.
//
// The added column is nullable, unlike the NOT NULL the fresh schema declares:
// ALTER TABLE ADD COLUMN cannot assert NOT NULL on a populated table without a
// rewrite, and the two shapes have to agree behaviourally instead. That agreement
// is what this test fixes — a migrated row reads as unrestricted, which is exactly
// how it behaved before the column existed.
func TestAllowedModelsMigratesOntoAnOlderDatabase(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.ExecContext(ctx, "DROP TABLE api_tokens"); err != nil {
		t.Fatalf("drop table: %v", err)
	}
	if _, err := database.ExecContext(ctx, apiTokensWithoutAllowedModels); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	digest := TokenDigest("legacy-value")
	if _, err := database.ExecContext(ctx, `INSERT INTO api_tokens
        (id, name, token, token_hash, token_preview, group_id)
        VALUES (1, 'legacy', ?, ?, '…', 1)`, digest, digest); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	if err := Init(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// The console view: an array, never null, and empty for a row nobody restricted.
	token, ok, err := GetToken(ctx, database, 1)
	if err != nil {
		t.Fatalf("get token: %v", err)
	}
	if !ok {
		t.Fatal("the migrated token is not readable")
	}
	if token.AllowedModels == nil {
		t.Error("allowed_models is nil, want an empty array so clients test one field")
	}
	if len(token.AllowedModels) != 0 {
		t.Errorf("allowed_models = %v on a migrated row, want empty", token.AllowedModels)
	}

	// The request path's view. The migration's default fills existing rows, but a
	// row written by an older binary against a newer file would carry NULL, and the
	// added column is nullable — so both states have to read as unrestricted.
	assertUnrestricted := func(t *testing.T, label string) {
		t.Helper()
		var stored *string
		if err := database.QueryRowContext(ctx,
			"SELECT allowed_models FROM api_tokens WHERE id = 1").Scan(&stored); err != nil {
			t.Fatalf("%s: read column: %v", label, err)
		}
		policy, err := models.ParseAllowedModels(stored)
		if err != nil {
			t.Fatalf("%s: parse: %v", label, err)
		}
		if !policy.Unrestricted() {
			t.Errorf("%s: policy is restricted, want unrestricted", label)
		}
		if !policy.Permits("any-model") {
			t.Errorf("%s: the row refused a model", label)
		}
	}

	assertUnrestricted(t, "the migrated default")

	if _, err := database.ExecContext(ctx,
		"UPDATE api_tokens SET allowed_models = NULL WHERE id = 1"); err != nil {
		t.Fatalf("clear column: %v", err)
	}
	assertUnrestricted(t, "an explicit NULL")
}

// TestAllowedModelsRoundTripsThroughTheStore covers create, read back and the
// full-replacement semantics of an edit.
func TestAllowedModelsRoundTripsThroughTheStore(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name:          "restricted",
		Enabled:       true,
		AllowedModels: []string{" GPT-4o ", "claude-3-*", "gpt-4O"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Deduplicated case-insensitively, but stored with the operator's spelling.
	if len(created.AllowedModels) != 2 {
		t.Fatalf("allowed_models = %v, want two distinct entries", created.AllowedModels)
	}
	if created.AllowedModels[0] != "GPT-4o" {
		t.Errorf("allowed_models[0] = %q, want the operator's own spelling",
			created.AllowedModels[0])
	}

	// An edit is a full replacement, like expires_at: an empty list clears the
	// restriction. Reading it as "leave it alone" would make a whitelist
	// impossible to remove through the console.
	updated, err := UpdateToken(ctx, database, created.ID, &models.APITokenUpdateIn{
		Name:          "restricted",
		AllowedModels: nil,
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(updated.AllowedModels) != 0 {
		t.Errorf("allowed_models = %v after clearing, want empty", updated.AllowedModels)
	}

	// And the value the request path reads agrees with what the console reports.
	var stored *string
	if err := database.QueryRowContext(ctx,
		"SELECT allowed_models FROM api_tokens WHERE id = ?", created.ID).Scan(&stored); err != nil {
		t.Fatalf("read column: %v", err)
	}
	if stored == nil || *stored != models.UnrestrictedAllowedModels {
		t.Errorf("stored = %v, want %q so writes have one spelling for unrestricted",
			stored, models.UnrestrictedAllowedModels)
	}
}

// TestAnInvalidWhitelistIsRefusedAtWriteTime keeps a pattern this matcher does
// not implement from reaching the column, where it would look enforced while
// matching nothing.
func TestAnInvalidWhitelistIsRefusedAtWriteTime(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := CreateToken(ctx, database, &models.APITokenIn{
		Name:          "bad",
		Enabled:       true,
		AllowedModels: []string{"gpt-*-turbo"},
	}); err == nil {
		t.Error("an inner wildcard was stored; it would match nothing while looking enforced")
	}

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "good", Enabled: true, AllowedModels: []string{"gpt-4o"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := UpdateToken(ctx, database, created.ID, &models.APITokenUpdateIn{
		Name:          "good",
		AllowedModels: []string{"gpt\x004o"},
	}); err == nil {
		t.Error("a control character was accepted through the update path")
	}
}
