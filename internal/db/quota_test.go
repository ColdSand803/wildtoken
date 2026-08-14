package db

import (
	"context"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestTokenQuotaIsStoredAndReportedThroughTheAPIShape(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "limited", Enabled: true, LimitExpression: "100M",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Quota.LimitTokens == nil || *created.Quota.LimitTokens != 100_000_000 {
		t.Fatalf("limit = %v, want 100000000", created.Quota.LimitTokens)
	}
	if created.Quota.LimitExpression != "100M" {
		t.Errorf("expression = %q, want 100M", created.Quota.LimitExpression)
	}
	if created.Quota.UsedTokens != 0 || created.Quota.Exhausted {
		t.Errorf("a new token started used: %+v", created.Quota)
	}

	// An unlimited token reports no limit rather than zero.
	unlimited, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "unlimited", Enabled: true,
	})
	if err != nil {
		t.Fatalf("create unlimited: %v", err)
	}
	if unlimited.Quota.LimitTokens != nil || unlimited.Quota.RemainingTokens != nil {
		t.Errorf("unlimited token carried a limit: %+v", unlimited.Quota)
	}
}

func TestUpdatingATokenChangesItsLimitWithoutTouchingUsage(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "client", Enabled: true, LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Simulate consumption the log writer would have recorded.
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 400000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	updated, err := UpdateToken(ctx, database, created.ID, &models.APITokenUpdateIn{
		Name: "client", LimitExpression: "2M",
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Quota.LimitTokens == nil || *updated.Quota.LimitTokens != 2_000_000 {
		t.Fatalf("limit = %v, want 2000000", updated.Quota.LimitTokens)
	}
	// Raising a limit must not forgive what was already spent.
	if updated.Quota.UsedTokens != 400_000 {
		t.Errorf("used = %d, want it preserved at 400000", updated.Quota.UsedTokens)
	}
	if updated.Quota.RemainingTokens == nil || *updated.Quota.RemainingTokens != 1_600_000 {
		t.Errorf("remaining = %v, want 1600000", updated.Quota.RemainingTokens)
	}

	// Clearing the expression removes the limit.
	cleared, err := UpdateToken(ctx, database, created.ID, &models.APITokenUpdateIn{
		Name: "client",
	})
	if err != nil {
		t.Fatalf("clear limit: %v", err)
	}
	if cleared.Quota.LimitTokens != nil {
		t.Errorf("limit = %v, want it cleared", cleared.Quota.LimitTokens)
	}
	if cleared.Quota.UsedTokens != 400_000 {
		t.Errorf("used = %d, want it preserved", cleared.Quota.UsedTokens)
	}
}

func TestResettingUsageClearsTheCounterButKeepsTheLimit(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "client", Enabled: true, LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 1500000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	// An overshot token reports remaining as zero, not negative.
	before, _, err := GetToken(ctx, database, created.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !before.Quota.Exhausted {
		t.Error("an overshot token was not exhausted")
	}
	if before.Quota.RemainingTokens == nil || *before.Quota.RemainingTokens != 0 {
		t.Errorf("remaining = %v, want 0", before.Quota.RemainingTokens)
	}

	reset, err := ResetTokenUsage(ctx, database, created.ID)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	if reset.Quota.UsedTokens != 0 {
		t.Errorf("used = %d, want 0", reset.Quota.UsedTokens)
	}
	if reset.Quota.LimitTokens == nil || *reset.Quota.LimitTokens != 1_000_000 {
		t.Errorf("reset dropped the limit: %v", reset.Quota.LimitTokens)
	}
	if reset.Quota.Exhausted {
		t.Error("a reset token was still exhausted")
	}

	if _, err := ResetTokenUsage(ctx, database, 4040); err == nil {
		t.Error("resetting a missing token succeeded")
	}
}

func TestAnInvalidLimitExpressionIsRejectedAtTheStore(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "bad", Enabled: true, LimitExpression: "100X",
	}); err == nil {
		t.Error("an unparseable limit was accepted")
	}
}

func TestUsageSurvivesLogRetentionPruning(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "client", Enabled: true, LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 750000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	// An old log carrying that usage, which retention will remove.
	if _, err := database.Exec(`INSERT INTO request_logs
        (created_at, method, path, client_type, downstream_token_id, stream, total_tokens)
        VALUES (datetime('now', '-40 days'), 'POST', '/v1/x', 'codex', ?, 0, 750000)`,
		created.ID); err != nil {
		t.Fatalf("insert old log: %v", err)
	}

	if err := DeleteOldLogs(ctx, database, 30); err != nil {
		t.Fatalf("prune: %v", err)
	}

	// This is the whole reason the counter lives on the token row: aggregating
	// request_logs would have let the quota refill when its usage aged out.
	after, _, err := GetToken(ctx, database, created.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if after.Quota.UsedTokens != 750_000 {
		t.Errorf("used = %d, want it to survive pruning at 750000", after.Quota.UsedTokens)
	}

	var remainingLogs int64
	if err := database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&remainingLogs); err != nil {
		t.Fatalf("count logs: %v", err)
	}
	if remainingLogs != 0 {
		t.Fatalf("the old log was not pruned, so the test proved nothing")
	}
}
