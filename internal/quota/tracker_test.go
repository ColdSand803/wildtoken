package quota

import (
	"sync"
	"testing"
)

func limitOf(value int64) *int64 { return &value }

func TestTrackerAdmitsWithinBudget(t *testing.T) {
	tracker := NewTracker()

	reservation, ok := tracker.Admit(1, 100, limitOf(1000))
	if !ok {
		t.Fatal("a token well inside its limit should be admitted")
	}
	if held := tracker.Outstanding(1); held != ProvisionalCost {
		t.Fatalf("outstanding = %d, want one provisional charge", held)
	}

	reservation.Release()
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Fatalf("expected the reservation to be released, %d tokens still held", tracked)
	}
}

func TestTrackerRefusesExhaustedQuota(t *testing.T) {
	tracker := NewTracker()

	_, ok := tracker.Admit(1, 1000, limitOf(1000))
	if ok {
		t.Fatal("a token at its limit should be refused")
	}
	// A refusal reserves nothing, so it cannot keep the next request out.
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Fatalf("a refused request left %d tokens held", tracked)
	}
}

func TestTrackerBoundsBurstAdmission(t *testing.T) {
	tracker := NewTracker()
	limit := limitOf(10 * ProvisionalCost)

	// This is what a check against the stored total alone could not see: every
	// request of a burst reads the same total, so each one finds the room that
	// the others have already taken.
	admitted := 0
	reservations := make([]Reservation, 0, 100)
	for range 100 {
		reservation, ok := tracker.Admit(1, 0, limit)
		if !ok {
			continue
		}
		admitted++
		reservations = append(reservations, reservation)
	}

	if admitted != 10 {
		t.Fatalf("expected the provisional charge to cap a burst at 10, got %d", admitted)
	}

	for i := range reservations {
		reservations[i].Release()
	}
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Fatalf("expected every reservation to be released, %d tokens still held", tracked)
	}
}

func TestTrackerHoldsMeteredUsageUntilSettled(t *testing.T) {
	tracker := NewTracker()
	limit := limitOf(1000)

	reservation, ok := tracker.Admit(1, 0, limit)
	if !ok {
		t.Fatal("the first request should be admitted")
	}
	tracker.Meter(1, 1000)
	reservation.Release()

	// The row has not committed, so the stored total still reads zero. Usage
	// that is already known has to keep the next request out until it lands.
	if _, ok := tracker.Admit(1, 0, limit); ok {
		t.Fatal("metered usage was not weighed against the limit")
	}

	tracker.Settle(1, 1000)
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Fatalf("expected settled usage to be dropped, %d tokens still held", tracked)
	}
	if _, ok := tracker.Admit(1, 1000, limitOf(2000)); !ok {
		t.Fatal("expected admission once the stored total carried the usage")
	}
}

func TestTrackerIgnoresUnlimitedTokens(t *testing.T) {
	tracker := NewTracker()

	for range 100 {
		reservation, ok := tracker.Admit(1, 1<<40, nil)
		if !ok {
			t.Fatal("a token with no limit must always be admitted")
		}
		reservation.Release()
	}
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Fatalf("a token with no limit has no budget to weigh, %d tokens held", tracked)
	}
}

func TestReservationReleaseIsIdempotent(t *testing.T) {
	tracker := NewTracker()
	limit := limitOf(10 * ProvisionalCost)

	first, _ := tracker.Admit(1, 0, limit)
	second, _ := tracker.Admit(1, 0, limit)

	first.Release()
	first.Release()

	if outstanding := tracker.Outstanding(1); outstanding != ProvisionalCost {
		t.Fatalf("a repeated release must not free another request's hold, outstanding %d", outstanding)
	}
	second.Release()
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Fatalf("expected the token to be dropped once idle, %d tokens held", tracked)
	}
}

func TestTrackerConcurrentAdmission(t *testing.T) {
	tracker := NewTracker()
	limit := limitOf(10 * ProvisionalCost)

	var mu sync.Mutex
	admitted := 0

	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			if _, ok := tracker.Admit(7, 0, limit); !ok {
				return
			}
			mu.Lock()
			admitted++
			mu.Unlock()
		})
	}
	wg.Wait()

	// Nothing is released, so the cap is exact however the goroutines interleave.
	if admitted != 10 {
		t.Fatalf("expected 10 concurrent admissions, got %d", admitted)
	}
}

func TestRetriesAreCoveredByOneReservation(t *testing.T) {
	tracker := NewTracker()

	// A downstream request that retries takes one reservation and meters each
	// attempt as its usage becomes known. The attempts run one after another,
	// so the provisional charge only ever stands in for the one in flight;
	// this asserts the finished ones are held at their real cost rather than
	// at another provisional charge each.
	reservation, ok := tracker.Admit(1, 0, limitOf(1<<40))
	if !ok {
		t.Fatal("a token with room should be admitted")
	}
	if held := tracker.Outstanding(1); held != ProvisionalCost {
		t.Fatalf("outstanding = %d, want one provisional charge", held)
	}

	tracker.Meter(1, 500) // the attempt that failed
	tracker.Meter(1, 800) // the attempt that succeeded
	reservation.Release()

	if held := tracker.Outstanding(1); held != 1300 {
		t.Errorf("outstanding = %d, want the exact 1300 the two attempts used", held)
	}

	tracker.Settle(1, 1300)
	if tracked := tracker.Tracked(); tracked != 0 {
		t.Errorf("%d tokens still held after both rows committed", tracked)
	}
}
