package db

import (
	"context"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// TestQuotaCycleRoundTripsThroughTheStore covers the console's path: configure a
// cycle, read it back, and change it.
func TestQuotaCycleRoundTripsThroughTheStore(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "monthly", Enabled: true, LimitExpression: "1M",
		QuotaPeriod: "monthly", QuotaTimezone: "Asia/Shanghai",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.QuotaPeriodState.Period != models.QuotaPeriodMonthly {
		t.Errorf("period = %q, want monthly", created.QuotaPeriodState.Period)
	}
	if created.QuotaPeriodState.Timezone != "Asia/Shanghai" {
		t.Errorf("timezone = %q, want Asia/Shanghai", created.QuotaPeriodState.Timezone)
	}
	// The console needs a next reset to show, and it must come from the server.
	if created.QuotaPeriodState.NextResetAt == nil {
		t.Error("next_reset_at is nil for a resetting token")
	}

	// Turning resets off is a full replacement, like clearing an expiry.
	updated, err := UpdateToken(ctx, database, created.ID, &models.APITokenUpdateIn{
		Name: "monthly", LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.QuotaPeriodState.Period != models.QuotaPeriodNone {
		t.Errorf("period = %q after clearing, want none", updated.QuotaPeriodState.Period)
	}
	if updated.QuotaPeriodState.NextResetAt != nil {
		t.Errorf("next_reset_at = %v for a non-resetting token, want nil",
			*updated.QuotaPeriodState.NextResetAt)
	}
}

// TestAnInvalidQuotaCycleIsRefusedAtWriteTime keeps a typo from storing a token
// that never resets while the form shows a cycle.
func TestAnInvalidQuotaCycleIsRefusedAtWriteTime(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	for name, input := range map[string]models.APITokenIn{
		"unknown period":   {Name: "a", Enabled: true, QuotaPeriod: "monthy"},
		"unknown timezone": {Name: "b", Enabled: true, QuotaPeriod: "daily", QuotaTimezone: "Not/AZone"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := CreateToken(ctx, database, &input); err == nil {
				t.Errorf("%s was accepted", name)
			}
		})
	}

	// A blank period and timezone default rather than failing, so a client that
	// does not send the fields gets the legacy behaviour.
	created, err := CreateToken(ctx, database, &models.APITokenIn{Name: "default", Enabled: true})
	if err != nil {
		t.Fatalf("create with defaults: %v", err)
	}
	if created.QuotaPeriodState.Period != models.QuotaPeriodNone {
		t.Errorf("period = %q, want none by default", created.QuotaPeriodState.Period)
	}
	if created.QuotaPeriodState.Timezone != models.DefaultQuotaTimezone {
		t.Errorf("timezone = %q, want %q by default",
			created.QuotaPeriodState.Timezone, models.DefaultQuotaTimezone)
	}
}

// TestTheConsoleReportsTheCurrentPeriodsUsageNotAStaleTotal is the reporting half
// of rollover.
//
// The counter is cleared by the first usage of a new period, not on the boundary
// itself, so between the boundary and that first request the row still holds the old
// figure. Reporting it would show a quota that did not reset when it said it would.
func TestTheConsoleReportsTheCurrentPeriodsUsageNotAStaleTotal(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "daily", Enabled: true, LimitExpression: "1M", QuotaPeriod: "daily",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Spend most of the budget under a period that is now closed.
	if err := ApplyTokenUsage(ctx, database, created.ID, 900_000,
		"daily:2000-01-01"); err != nil {
		t.Fatalf("apply: %v", err)
	}

	read, ok, err := GetToken(ctx, database, created.ID)
	if err != nil || !ok {
		t.Fatalf("read back: ok=%v err=%v", ok, err)
	}
	if read.Quota.UsedTokens != 0 {
		t.Errorf("used_tokens = %d, want 0: the stored figure describes a closed period",
			read.Quota.UsedTokens)
	}
	if read.Quota.Exhausted {
		t.Error("the token reports exhausted on a period that has already closed")
	}

	// Usage in the current period is reported normally.
	current := models.QuotaPeriodStamp(models.QuotaPeriodDaily, time.Now(), time.UTC)
	if err := ApplyTokenUsage(ctx, database, created.ID, 1_234, current); err != nil {
		t.Fatalf("apply current: %v", err)
	}
	read, _, err = GetToken(ctx, database, created.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if read.Quota.UsedTokens != 1_234 {
		t.Errorf("used_tokens = %d, want 1234 for the current period", read.Quota.UsedTokens)
	}
}

// TestAnExhaustedTokenServesAgainInTheNextPeriod is the feature's whole purpose,
// checked against the same helpers admission uses.
func TestAnExhaustedTokenServesAgainInTheNextPeriod(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	created, err := CreateToken(ctx, database, &models.APITokenIn{
		Name: "daily", Enabled: true, LimitExpression: "100K", QuotaPeriod: "daily",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Exhaust it inside today's period.
	today := models.QuotaPeriodStamp(models.QuotaPeriodDaily, time.Now(), time.UTC)
	if err := ApplyTokenUsage(ctx, database, created.ID, 100_000, today); err != nil {
		t.Fatalf("exhaust: %v", err)
	}
	read, _, err := GetToken(ctx, database, created.ID)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !read.Quota.Exhausted {
		t.Fatalf("used %d of %v, want the token reported exhausted",
			read.Quota.UsedTokens, read.Quota.LimitTokens)
	}

	// Tomorrow's first request rolls the period over as it is recorded.
	tomorrow := models.QuotaPeriodStamp(models.QuotaPeriodDaily,
		time.Now().AddDate(0, 0, 1), time.UTC)
	if tomorrow == today {
		t.Fatal("the two stamps are equal; the fixture cannot distinguish the periods")
	}
	if err := ApplyTokenUsage(ctx, database, created.ID, 500, tomorrow); err != nil {
		t.Fatalf("next period: %v", err)
	}

	used, stamp := readUsage(t, database, created.ID)
	if used != 500 {
		t.Errorf("used_tokens = %d, want 500: the new period starts at this request", used)
	}
	if stamp != tomorrow {
		t.Errorf("stamp = %q, want %q", stamp, tomorrow)
	}
}
