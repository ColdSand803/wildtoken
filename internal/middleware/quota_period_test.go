package middleware

import (
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/quota"
)

// TestAdmissionIgnoresAClosedPeriodsUsage is the admission half of rollover.
//
// The counter is cleared by the first usage of a new period, not on the boundary,
// so between the two the row still holds the old figure. Weighing it would refuse
// the very request that is supposed to perform the rollover — a token would stay
// exhausted forever, because the request that would clear it can never run.
func TestAdmissionIgnoresAClosedPeriodsUsage(t *testing.T) {
	limit := int64(100_000)
	credential := DownstreamCredential{
		TokenID:           1,
		UsedTokens:        100_000, // fully spent
		LimitTokens:       &limit,
		QuotaPeriod:       models.QuotaPeriodDaily,
		QuotaTimezone:     "UTC",
		StoredPeriodStamp: "daily:2026-08-19",
	}

	// Still inside the period it was spent in: exhausted.
	if used := credential.UsedTokensInCurrentPeriod("daily:2026-08-19"); used != 100_000 {
		t.Errorf("used = %d inside the spent period, want the full 100000", used)
	}
	// The next period: nothing spent yet.
	if used := credential.UsedTokensInCurrentPeriod("daily:2026-08-20"); used != 0 {
		t.Errorf("used = %d in a fresh period, want 0: the row has not been cleared "+
			"yet because clearing happens with the first usage", used)
	}
}

// TestAPeriodTypeChangeStillCountsTheStoredUsage keeps admission in step with the
// applying statement.
//
// db.ApplyTokenUsage carries the stored total forward across a period-type change
// rather than discarding it, so admission has to weigh it too. Reading it as zero
// would admit a token past its limit for one request after every configuration
// change.
func TestAPeriodTypeChangeStillCountsTheStoredUsage(t *testing.T) {
	limit := int64(100_000)
	credential := DownstreamCredential{
		TokenID:           1,
		UsedTokens:        90_000,
		LimitTokens:       &limit,
		QuotaPeriod:       models.QuotaPeriodMonthly,
		QuotaTimezone:     "UTC",
		StoredPeriodStamp: "daily:2026-08-19", // earned before the switch to monthly
	}

	if used := credential.UsedTokensInCurrentPeriod("monthly:2026-08"); used != 90_000 {
		t.Errorf("used = %d across a period-type change, want 90000 still counted", used)
	}
}

// TestANonResettingTokenReportsItsLifetimeTotal keeps the legacy path unchanged.
func TestANonResettingTokenReportsItsLifetimeTotal(t *testing.T) {
	limit := int64(100_000)
	credential := DownstreamCredential{
		TokenID:     1,
		UsedTokens:  42_000,
		LimitTokens: &limit,
		QuotaPeriod: models.QuotaPeriodNone,
	}
	// The stamp is empty for a token that never resets.
	if used := credential.UsedTokensInCurrentPeriod(""); used != 42_000 {
		t.Errorf("used = %d, want the lifetime total of 42000", used)
	}
}

// TestOutstandingHoldsDoNotCrossAPeriodBoundary is the tracker half.
//
// Without the period in the tracker's key, holds taken before a boundary keep
// counting against the budget after it: a token with a busy midnight would be
// refused at the exact moment its budget refilled.
func TestOutstandingHoldsDoNotCrossAPeriodBoundary(t *testing.T) {
	tracker := quota.NewTracker()
	limit := int64(10 * quota.ProvisionalCost)

	// Fill the old period with in-flight requests, holding them open.
	var held []quota.Reservation
	for range 9 {
		reservation, ok := tracker.Admit(1, "daily:2026-08-19", 0, &limit)
		if !ok {
			t.Fatal("a request was refused while the old period still had room")
		}
		held = append(held, reservation)
	}
	// The old period is now at its ceiling.
	if _, ok := tracker.Admit(1, "daily:2026-08-19", quota.ProvisionalCost, &limit); ok {
		t.Error("the old period admitted a request past its limit")
	}

	// The new period starts with nothing outstanding, even though nine requests
	// from the old one are still running.
	if outstanding := tracker.Outstanding(1, "daily:2026-08-20"); outstanding != 0 {
		t.Errorf("outstanding = %d in a fresh period, want 0", outstanding)
	}
	if _, ok := tracker.Admit(1, "daily:2026-08-20", 0, &limit); !ok {
		t.Error("a fresh period refused a request because of the previous period's traffic")
	}

	for i := range held {
		held[i].Release()
	}
}

// TestAStragglersHoldIsReleasedAgainstItsOwnPeriod: releasing against the current
// period would leave the closed period's hold outstanding forever, permanently
// shrinking the budget it applied to.
func TestAStragglersHoldIsReleasedAgainstItsOwnPeriod(t *testing.T) {
	tracker := quota.NewTracker()

	tracker.Meter(1, "daily:2026-08-19", 5_000)
	if outstanding := tracker.Outstanding(1, "daily:2026-08-19"); outstanding != 5_000 {
		t.Fatalf("outstanding = %d, want 5000 metered", outstanding)
	}

	// Settling against the wrong period leaves the hold in place.
	tracker.Settle(1, "daily:2026-08-20", 5_000)
	if outstanding := tracker.Outstanding(1, "daily:2026-08-19"); outstanding != 5_000 {
		t.Errorf("outstanding = %d after settling the wrong period, want the hold intact",
			outstanding)
	}

	// Settling against its own period releases it, and the tracker forgets the
	// scope entirely — which is what bounds the map across boundaries.
	tracker.Settle(1, "daily:2026-08-19", 5_000)
	if outstanding := tracker.Outstanding(1, "daily:2026-08-19"); outstanding != 0 {
		t.Errorf("outstanding = %d, want 0", outstanding)
	}
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Errorf("tracked scopes = %d, want 0: a closed period's entry must not leak", tracked)
	}
}

// TestTheAdmittedStampMatchesTheCurrentPeriod ties the resolved stamp to the
// calendar, so admission and settlement agree on the same value.
func TestTheAdmittedStampMatchesTheCurrentPeriod(t *testing.T) {
	now := time.Date(2026, 8, 19, 23, 59, 59, 0, time.UTC)

	stamp := models.QuotaPeriodStamp(models.QuotaPeriodDaily, now, time.UTC)
	if stamp != "daily:2026-08-19" {
		t.Fatalf("stamp = %q, want daily:2026-08-19", stamp)
	}
	// One second later is a different period, which is exactly the window a
	// straggler is admitted in and commits after.
	next := models.QuotaPeriodStamp(models.QuotaPeriodDaily, now.Add(time.Second), time.UTC)
	if next != "daily:2026-08-20" {
		t.Errorf("stamp one second later = %q, want daily:2026-08-20", next)
	}
	if stamp == next {
		t.Error("the boundary did not change the stamp")
	}
}
