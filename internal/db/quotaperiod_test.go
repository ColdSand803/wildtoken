package db

import (
	"context"
	"database/sql"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// tokenWithCycle inserts a credential configured for a reset cycle.
func tokenWithCycle(t *testing.T, database *sql.DB, name, period, timezone string,
	limit int64) int64 {
	t.Helper()
	digest := TokenDigest(name + "-value")
	result, err := database.Exec(`INSERT INTO api_tokens
        (name, token, token_hash, token_preview, group_id, limit_tokens,
         quota_period, quota_timezone, quota_period_key)
        VALUES (?, ?, ?, '…', 1, ?, ?, ?, '')`,
		name, digest, digest, limit, period, timezone)
	if err != nil {
		t.Fatalf("insert token: %v", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	return id
}

// readUsage returns the stored counter and the period it was accumulated under.
func readUsage(t *testing.T, database *sql.DB, tokenID int64) (int64, string) {
	t.Helper()
	var used int64
	var key string
	if err := database.QueryRow(
		"SELECT COALESCE(used_tokens, 0), COALESCE(quota_period_key, '') FROM api_tokens WHERE id = ?",
		tokenID).Scan(&used, &key); err != nil {
		t.Fatalf("read usage: %v", err)
	}
	return used, key
}

// TestUsageAccumulatesWithinAPeriod is the ordinary case.
func TestUsageAccumulatesWithinAPeriod(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	id := tokenWithCycle(t, database, "daily", models.QuotaPeriodDaily, "UTC", 1_000_000)

	for range 3 {
		if err := ApplyTokenUsage(ctx, database, id, 1_000, "daily:2026-08-19"); err != nil {
			t.Fatalf("apply: %v", err)
		}
	}

	used, stamp := readUsage(t, database, id)
	if used != 3_000 {
		t.Errorf("used_tokens = %d, want 3000 accumulated", used)
	}
	if stamp != "daily:2026-08-19" {
		t.Errorf("period stamp = %q, want the period the usage was earned in", stamp)
	}
}

// TestTheFirstUsageOfANewPeriodRollsTheCounterOver is the replacement for a
// scheduled `used_tokens = 0`.
//
// The reset happens atomically with recording the request that triggered it, so
// there is no instant at which the counter has been cleared but the request that
// cleared it is unaccounted for.
func TestTheFirstUsageOfANewPeriodRollsTheCounterOver(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	id := tokenWithCycle(t, database, "daily", models.QuotaPeriodDaily, "UTC", 1_000_000)

	if err := ApplyTokenUsage(ctx, database, id, 900_000, "daily:2026-08-19"); err != nil {
		t.Fatalf("apply first day: %v", err)
	}
	if used, _ := readUsage(t, database, id); used != 900_000 {
		t.Fatalf("used_tokens = %d after the first day, want 900000", used)
	}

	// The next day's first request.
	if err := ApplyTokenUsage(ctx, database, id, 500, "daily:2026-08-20"); err != nil {
		t.Fatalf("apply second day: %v", err)
	}

	used, stamp := readUsage(t, database, id)
	// The new period starts at this request's usage, not at zero and not at the
	// old total plus this request.
	if used != 500 {
		t.Errorf("used_tokens = %d after rollover, want 500: the first request of the "+
			"new period is counted, the old period's usage is not", used)
	}
	if stamp != "daily:2026-08-20" {
		t.Errorf("period stamp = %q, want the new period", stamp)
	}
}

// TestLateArrivingUsageDoesNotPolluteTheNewPeriod is the specific failure the
// checklist forbids: a request admitted before the boundary whose log row commits
// after it must not spend the new period's budget.
func TestLateArrivingUsageDoesNotPolluteTheNewPeriod(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	id := tokenWithCycle(t, database, "daily", models.QuotaPeriodDaily, "UTC", 1_000_000)

	// The new period has already started and recorded a request.
	if err := ApplyTokenUsage(ctx, database, id, 1_000, "daily:2026-08-20"); err != nil {
		t.Fatalf("apply new period: %v", err)
	}

	// Now yesterday's straggler commits, carrying yesterday's stamp.
	if err := ApplyTokenUsage(ctx, database, id, 800_000, "daily:2026-08-19"); err != nil {
		t.Fatalf("apply straggler: %v", err)
	}

	used, stamp := readUsage(t, database, id)
	if used != 1_000 {
		t.Errorf("used_tokens = %d, want 1000: the straggler belongs to a closed period "+
			"and must not spend the new one's budget", used)
	}
	if stamp != "daily:2026-08-20" {
		t.Errorf("period stamp = %q, want the straggler not to move it back", stamp)
	}
}

// TestATokenThatNeverResetsAccumulatesForever keeps the legacy path byte-identical.
func TestATokenThatNeverResetsAccumulatesForever(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	id := tokenWithCycle(t, database, "lifetime", models.QuotaPeriodNone, "UTC", 1_000_000)

	// The stamp is empty for every request, whenever it happens.
	for range 4 {
		if err := ApplyTokenUsage(ctx, database, id, 250, ""); err != nil {
			t.Fatalf("apply: %v", err)
		}
	}

	used, stamp := readUsage(t, database, id)
	if used != 1_000 {
		t.Errorf("used_tokens = %d, want 1000 accumulated as a lifetime total", used)
	}
	if stamp != "" {
		t.Errorf("period stamp = %q, want empty for a token that never resets", stamp)
	}
}

// TestChangingThePeriodTypeDoesNotWipeOrDropUsage covers the case that makes a
// bare key comparison unsafe.
//
// Key shapes differ per type ("2026-08-19" vs "2026-08"), so a daily key compares
// greater than a monthly one. Without the period type in the comparison, switching
// a token from monthly to daily would let the first daily request restart the
// counter, and switching the other way would silently drop usage as "late".
func TestChangingThePeriodTypeDoesNotWipeOrDropUsage(t *testing.T) {
	t.Run("daily to monthly", func(t *testing.T) {
		database := memoryDB(t)
		ctx := context.Background()
		id := tokenWithCycle(t, database, "switching", models.QuotaPeriodDaily, "UTC", 1_000_000)

		if err := ApplyTokenUsage(ctx, database, id, 5_000, "daily:2026-08-19"); err != nil {
			t.Fatalf("apply daily: %v", err)
		}
		// The operator switches the token to monthly.
		if _, err := database.ExecContext(ctx,
			"UPDATE api_tokens SET quota_period = 'monthly' WHERE id = ?", id); err != nil {
			t.Fatalf("switch period: %v", err)
		}

		// The monthly calendar key is lexically *less* than the stored daily one, so
		// comparing bare keys would call this a straggler and drop it.
		if err := ApplyTokenUsage(ctx, database, id, 3_000, "monthly:2026-08"); err != nil {
			t.Fatalf("apply monthly: %v", err)
		}
		if used, _ := readUsage(t, database, id); used != 8_000 {
			t.Errorf("used_tokens = %d, want 8000: usage after a period-type change is "+
				"real and must not be dropped", used)
		}
	})

	t.Run("monthly to daily", func(t *testing.T) {
		database := memoryDB(t)
		ctx := context.Background()
		id := tokenWithCycle(t, database, "switching", models.QuotaPeriodMonthly, "UTC", 1_000_000)

		if err := ApplyTokenUsage(ctx, database, id, 5_000, "monthly:2026-08"); err != nil {
			t.Fatalf("apply monthly: %v", err)
		}
		if _, err := database.ExecContext(ctx,
			"UPDATE api_tokens SET quota_period = 'daily' WHERE id = ?", id); err != nil {
			t.Fatalf("switch period: %v", err)
		}

		// The daily calendar key is lexically greater, so comparing bare keys would
		// restart the counter and hand back budget already spent this month.
		if err := ApplyTokenUsage(ctx, database, id, 3_000, "daily:2026-08-19"); err != nil {
			t.Fatalf("apply daily: %v", err)
		}
		if used, _ := readUsage(t, database, id); used != 8_000 {
			t.Errorf("used_tokens = %d, want 8000: a period-type change must not hand "+
				"back budget already spent", used)
		}
	})
}

// TestPeriodStateSurvivesARestart is the persistence requirement: the cycle is
// derived from stored columns, so nothing is lost when the process stops.
func TestPeriodStateSurvivesARestart(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	id := tokenWithCycle(t, database, "daily", models.QuotaPeriodDaily, "Asia/Shanghai", 1_000_000)

	if err := ApplyTokenUsage(ctx, database, id, 7_500, "daily:2026-08-19"); err != nil {
		t.Fatalf("apply: %v", err)
	}

	// A restart reads the cycle back from the row; there is no in-memory state to
	// lose, which is why rollover needs no recovery step.
	cycle, ok, err := ReadTokenQuotaCycle(ctx, database, id)
	if err != nil || !ok {
		t.Fatalf("read cycle: ok=%v err=%v", ok, err)
	}
	if cycle.Period != models.QuotaPeriodDaily {
		t.Errorf("period = %q, want daily", cycle.Period)
	}
	if cycle.Timezone != "Asia/Shanghai" {
		t.Errorf("timezone = %q, want Asia/Shanghai", cycle.Timezone)
	}
	if cycle.PeriodStamp != "daily:2026-08-19" {
		t.Errorf("period stamp = %q, want the period the usage was earned in",
			cycle.PeriodStamp)
	}

	// And usage continues to accumulate in that period rather than restarting.
	if err := ApplyTokenUsage(ctx, database, id, 2_500, cycle.PeriodStamp); err != nil {
		t.Fatalf("apply after restart: %v", err)
	}
	if used, _ := readUsage(t, database, id); used != 10_000 {
		t.Errorf("used_tokens = %d after a restart, want 10000", used)
	}
}

// TestAnUnrecognisedStoredPeriodReadsAsNone keeps a row edited out of band
// accumulating rather than resetting on a boundary nobody configured.
//
// The fresh schema's CHECK refuses such a value outright, which is asserted below.
// It is only reachable on an upgraded database, where ALTER TABLE ADD COLUMN cannot
// carry the constraint — so that is the shape this exercises.
func TestAnUnrecognisedStoredPeriodReadsAsNone(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// The fresh table's CHECK is the first line of defence.
	id := tokenWithCycle(t, database, "odd", models.QuotaPeriodDaily, "UTC", 1_000_000)
	if _, err := database.ExecContext(ctx,
		"UPDATE api_tokens SET quota_period = 'fortnightly' WHERE id = ?", id); err == nil {
		t.Error("the fresh schema accepted an unrecognised period; the CHECK is not doing its job")
	}

	// The migrated column has no CHECK, so the read path has to be the defence.
	if _, err := database.ExecContext(ctx, "DROP TABLE api_tokens"); err != nil {
		t.Fatalf("drop table: %v", err)
	}
	if _, err := database.ExecContext(ctx, apiTokensWithoutAllowedModels); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	digest := TokenDigest("odd-value")
	if _, err := database.ExecContext(ctx, `INSERT INTO api_tokens
        (id, name, token, token_hash, token_preview, group_id)
        VALUES (1, 'odd', ?, ?, '…', 1)`, digest, digest); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}
	if err := Init(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		"UPDATE api_tokens SET quota_period = 'fortnightly' WHERE id = 1"); err != nil {
		t.Fatalf("corrupt period on the migrated table: %v", err)
	}

	cycle, ok, err := ReadTokenQuotaCycle(ctx, database, 1)
	if err != nil || !ok {
		t.Fatalf("read cycle: ok=%v err=%v", ok, err)
	}
	if cycle.Period != models.QuotaPeriodNone {
		t.Errorf("period = %q, want none: the conservative direction, since the "+
			"alternative hands back budget on an unconfigured boundary", cycle.Period)
	}
}

// TestQuotaCycleColumnsMigrateOntoAnOlderDatabase: an upgraded database keeps
// every token as a lifetime total until an operator chooses otherwise.
func TestQuotaCycleColumnsMigrateOntoAnOlderDatabase(t *testing.T) {
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
        (id, name, token, token_hash, token_preview, group_id, used_tokens, limit_tokens)
        VALUES (1, 'legacy', ?, ?, '…', 1, 4321, 1000000)`, digest, digest); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	if err := Init(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cycle, ok, err := ReadTokenQuotaCycle(ctx, database, 1)
	if err != nil || !ok {
		t.Fatalf("read cycle: ok=%v err=%v", ok, err)
	}
	if cycle.Period != models.QuotaPeriodNone {
		t.Errorf("period = %q on a migrated row, want none", cycle.Period)
	}
	if cycle.Timezone != models.DefaultQuotaTimezone {
		t.Errorf("timezone = %q, want %q", cycle.Timezone, models.DefaultQuotaTimezone)
	}
	if cycle.PeriodStamp != "" {
		t.Errorf("period stamp = %q, want empty", cycle.PeriodStamp)
	}

	// The usage it had carried is intact — a migration must not clear a quota.
	if used, _ := readUsage(t, database, 1); used != 4321 {
		t.Errorf("used_tokens = %d after migration, want 4321 preserved", used)
	}

	// And it keeps accumulating as a lifetime total.
	if err := ApplyTokenUsage(ctx, database, 1, 79, ""); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if used, _ := readUsage(t, database, 1); used != 4400 {
		t.Errorf("used_tokens = %d, want 4400", used)
	}
}

// TestConcurrentUsageAppliesEveryAmountExactlyOnce guards the atomicity claim: the
// rollover is one UPDATE, so concurrent writers cannot interleave a read and a
// write and lose an amount.
func TestConcurrentUsageAppliesEveryAmountExactlyOnce(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	id := tokenWithCycle(t, database, "busy", models.QuotaPeriodDaily, "UTC", 1<<40)

	const writers = 20
	const perWriter = 10
	errs := make(chan error, writers)
	for range writers {
		go func() {
			for range perWriter {
				if err := ApplyTokenUsage(ctx, database, id, 100, "daily:2026-08-19"); err != nil {
					errs <- err
					return
				}
			}
			errs <- nil
		}()
	}
	for range writers {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent apply: %v", err)
		}
	}

	used, _ := readUsage(t, database, id)
	if want := int64(writers * perWriter * 100); used != want {
		t.Errorf("used_tokens = %d, want %d: an amount was lost to a race", used, want)
	}
}
