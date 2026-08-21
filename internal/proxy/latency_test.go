package proxy

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// fixedClockTracker is a tracker whose clock the test moves, so sample expiry can
// be exercised without a five-minute sleep.
type fixedClockTracker struct {
	*LatencyTracker
	now time.Time
}

func newFixedClockTracker() *fixedClockTracker {
	clock := &fixedClockTracker{
		LatencyTracker: NewLatencyTracker(),
		now:            time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
	}
	clock.LatencyTracker.now = func() time.Time { return clock.now }
	return clock
}

func (c *fixedClockTracker) advance(d time.Duration) { c.now = c.now.Add(d) }

// recordSamples folds a run of measurements into one channel.
func recordSamples(tracker *LatencyTracker, upstreamID int64, samples ...int32) {
	for _, sample := range samples {
		value := sample
		tracker.Record(upstreamID, &value)
	}
}

// selectLeastLatency runs one routing decision under the least-latency strategy.
func selectLeastLatency(t *testing.T, database *sql.DB, tracker *LatencyTracker,
	model *string) *Selection {
	t.Helper()
	selection, err := SelectUpstream(context.Background(), database, NewRoutingCache(),
		NewAutoWeightManager(), testPolicy(),
		SelectionPolicy{Strategy: models.LoadBalanceLeastLatency, Latency: tracker},
		nil, model, models.DefaultGroupID, nil)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	return selection
}

// countSelections runs the decision repeatedly and reports how often each channel
// won, which is the only way to observe a weighted choice.
func countSelections(t *testing.T, database *sql.DB, tracker *LatencyTracker,
	model *string, runs int) map[string]int {
	t.Helper()
	counts := map[string]int{}
	for i := 0; i < runs; i++ {
		selection := selectLeastLatency(t, database, tracker, model)
		if selection == nil {
			t.Fatal("no channel was routable")
		}
		counts[selection.Upstream.Name]++
	}
	return counts
}

// TestLatencyReadingNeedsAMinimumOfSamples is the low-sample rule: until a
// channel has answered enough times its median is one lucky request, and routing
// on it is how a channel with a single 40ms response takes traffic from one that
// has answered a thousand in 60ms.
func TestLatencyReadingNeedsAMinimumOfSamples(t *testing.T) {
	tracker := NewLatencyTracker()

	for count := 1; count < LatencyMinSamples; count++ {
		recordSamples(tracker, 1, 100)
		reading := tracker.Read(1)
		if reading.Usable {
			t.Fatalf("%d samples were treated as usable", count)
		}
		// Not usable is not the same as unmeasured: the console shows the count as
		// "collecting samples", which needs the number.
		if reading.SampleCount != count {
			t.Errorf("SampleCount = %d, want %d", reading.SampleCount, count)
		}
	}

	recordSamples(tracker, 1, 100)
	reading := tracker.Read(1)
	if !reading.Usable {
		t.Fatalf("%d samples were still not usable", LatencyMinSamples)
	}
	if reading.MedianMs != 100 {
		t.Errorf("MedianMs = %d, want 100", reading.MedianMs)
	}
}

// TestUnmeasuredChannelReadsAsNoData covers cold start at the data layer: a
// channel nobody has called has no latency, which is different from having a
// latency of zero.
func TestUnmeasuredChannelReadsAsNoData(t *testing.T) {
	tracker := NewLatencyTracker()
	reading := tracker.Read(404)
	if reading.Usable || reading.SampleCount != 0 || reading.MedianMs != 0 {
		t.Errorf("reading = %+v, want an empty reading", reading)
	}
}

// TestNilTrackerIsSafeToUse keeps a caller assembled without a tracker — a
// harness, a probe — from having to guard every call site.
func TestNilTrackerIsSafeToUse(t *testing.T) {
	var tracker *LatencyTracker
	sample := int32(10)
	tracker.Record(1, &sample)
	tracker.Reset(1)
	if reading := tracker.Read(1); reading.Usable {
		t.Errorf("a nil tracker reported %+v", reading)
	}
}

// TestUnsampledResponseIsNotRecordedAsFast keeps a missing measurement from
// entering the ring as a zero. A response whose timing was never taken is not a
// fast response, and five of them would make a channel unbeatable.
func TestUnsampledResponseIsNotRecordedAsFast(t *testing.T) {
	tracker := NewLatencyTracker()
	for i := 0; i < LatencyMinSamples*2; i++ {
		tracker.Record(1, nil)
	}
	negative := int32(-1)
	tracker.Record(1, &negative)

	if reading := tracker.Read(1); reading.SampleCount != 0 {
		t.Errorf("SampleCount = %d, want 0 from unsampled responses", reading.SampleCount)
	}
}

// TestSamplesExpireOutOfTheWindow is the staleness rule. A channel that served
// traffic and then went idle has no current latency; keeping the old figure is
// how a channel that degraded while idle keeps winning every decision.
func TestSamplesExpireOutOfTheWindow(t *testing.T) {
	clock := newFixedClockTracker()
	recordSamples(clock.LatencyTracker, 1, 50, 50, 50, 50, 50, 50)
	if !clock.Read(1).Usable {
		t.Fatal("fresh samples were not usable")
	}

	// Just inside the window: still the channel's latency.
	clock.advance(LatencyStaleWindow - time.Second)
	if reading := clock.Read(1); !reading.Usable {
		t.Errorf("samples %v old were dropped early", LatencyStaleWindow-time.Second)
	}

	// Past it: gone, and reported as unmeasured rather than as slow.
	clock.advance(2 * time.Second)
	if reading := clock.Read(1); reading.Usable || reading.SampleCount != 0 {
		t.Errorf("reading = %+v, want the expired samples gone", reading)
	}
}

// TestExpiredSamplesAreMixedWithFreshOnes checks partial expiry: the window
// applies per sample, not to the ring as a whole.
func TestExpiredSamplesAreMixedWithFreshOnes(t *testing.T) {
	clock := newFixedClockTracker()
	// Six old and slow.
	recordSamples(clock.LatencyTracker, 1, 900, 900, 900, 900, 900, 900)
	clock.advance(LatencyStaleWindow + time.Second)
	// Five new and fast.
	recordSamples(clock.LatencyTracker, 1, 40, 40, 40, 40, 40)

	reading := clock.Read(1)
	if !reading.Usable {
		t.Fatal("the fresh samples were not usable")
	}
	if reading.SampleCount != 5 {
		t.Errorf("SampleCount = %d, want only the 5 fresh samples", reading.SampleCount)
	}
	if reading.MedianMs != 40 {
		t.Errorf("MedianMs = %d, want 40: the expired samples still count", reading.MedianMs)
	}
}

// TestOneOutlierDoesNotMoveTheMedian is why the median is used rather than the
// mean. A mean over these samples lands near 3.7 seconds and would keep the
// channel out of routing for the whole window over a single cold start.
func TestOneOutlierDoesNotMoveTheMedian(t *testing.T) {
	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 60, 62, 58, 61, 59, 30000)

	reading := tracker.Read(1)
	if !reading.Usable {
		t.Fatal("reading was not usable")
	}
	if reading.MedianMs > 100 {
		t.Errorf("MedianMs = %d, want the outlier ignored", reading.MedianMs)
	}
}

// TestRingKeepsOnlyItsMostRecentSamples pins the bound. This structure exists
// because it sits on the routing hot path, and an unbounded history would grow
// with traffic and describe a channel as it was rather than as it is.
func TestRingKeepsOnlyItsMostRecentSamples(t *testing.T) {
	tracker := NewLatencyTracker()
	for i := 0; i < LatencySampleCapacity*3; i++ {
		recordSamples(tracker, 1, 900)
	}
	if reading := tracker.Read(1); reading.SampleCount != LatencySampleCapacity {
		t.Errorf("SampleCount = %d, want the capacity of %d",
			reading.SampleCount, LatencySampleCapacity)
	}

	// A channel that has become fast is reflected once its recent history is
	// fast, not averaged forever against what it used to be.
	for i := 0; i < LatencySampleCapacity; i++ {
		recordSamples(tracker, 1, 50)
	}
	if reading := tracker.Read(1); reading.MedianMs != 50 {
		t.Errorf("MedianMs = %d, want 50 after the history turned over", reading.MedianMs)
	}
}

// TestResetDropsAChannelsHistory covers an edited channel: a new base URL or
// model mapping makes the old measurements describe something it no longer is.
func TestResetDropsAChannelsHistory(t *testing.T) {
	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 50, 50, 50, 50, 50)
	tracker.Reset(1)
	if reading := tracker.Read(1); reading.SampleCount != 0 {
		t.Errorf("reading = %+v, want the history dropped", reading)
	}
}

// TestLeastLatencyPrefersTheFasterChannel is the strategy's whole point, observed
// where it matters: the routing decision itself.
func TestLeastLatencyPrefersTheFasterChannel(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "fast", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "slow", []string{"m"}, 100, 100, true)

	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 50, 52, 48, 51, 49)
	recordSamples(tracker, 2, 800, 820, 790, 810, 805)

	counts := countSelections(t, database, tracker, ptr("m"), 200)
	if counts["slow"] != 0 {
		t.Errorf("the slow channel won %d of 200 decisions, want none", counts["slow"])
	}
	if counts["fast"] != 200 {
		t.Errorf("the fast channel won %d of 200, want all", counts["fast"])
	}
}

// TestLeastLatencyKeepsChannelsInsideTheToleranceBand is the hysteresis rule.
// Ranking on a strict minimum would move every request to whichever channel is
// two milliseconds ahead this second, which concentrates load on one channel and
// then oscillates as that load slows it down.
func TestLeastLatencyKeepsChannelsInsideTheToleranceBand(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "a", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "b", []string{"m"}, 100, 100, true)

	tracker := NewLatencyTracker()
	// Within the 20% band, and well within the 50ms floor.
	recordSamples(tracker, 1, 200, 200, 200, 200, 200)
	recordSamples(tracker, 2, 215, 215, 215, 215, 215)

	counts := countSelections(t, database, tracker, ptr("m"), 400)
	// Both stay in contention, so weight still decides between them.
	if counts["a"] == 0 || counts["b"] == 0 {
		t.Errorf("counts = %v, want both channels in contention", counts)
	}
}

// TestToleranceHasAFloorForFastChannels keeps the band from collapsing when
// everything is fast. At 20ms a proportional band is 4ms, which is less than the
// jitter between two healthy channels — the floor is what stops that jitter from
// deciding routing.
func TestToleranceHasAFloorForFastChannels(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "a", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "b", []string{"m"}, 100, 100, true)

	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 20, 20, 20, 20, 20)
	recordSamples(tracker, 2, 60, 60, 60, 60, 60)

	counts := countSelections(t, database, tracker, ptr("m"), 400)
	if counts["b"] == 0 {
		t.Errorf("counts = %v, want the 60ms channel kept by the %dms floor",
			counts, LatencyToleranceFloorMs)
	}

	// Outside the floor it is excluded, so the floor is a floor and not a licence.
	recordSamples(tracker, 2, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500)
	counts = countSelections(t, database, tracker, ptr("m"), 200)
	if counts["b"] != 0 {
		t.Errorf("the 500ms channel won %d decisions against a 20ms one", counts["b"])
	}
}

// TestColdStartFallsBackToWeightedSelection is the no-data rule. With nothing
// measured there is nothing to rank by, and the tier has to behave exactly as it
// did before the strategy existed.
func TestColdStartFallsBackToWeightedSelection(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "heavy", []string{"m"}, 100, 900, true)
	insertUpstream(t, database, "light", []string{"m"}, 100, 100, true)

	counts := countSelections(t, database, NewLatencyTracker(), ptr("m"), 600)
	if counts["heavy"] == 0 || counts["light"] == 0 {
		t.Fatalf("counts = %v, want weighted selection across both", counts)
	}
	// Weight still decides, which is what "no data" has to mean.
	if counts["heavy"] <= counts["light"] {
		t.Errorf("counts = %v, want the 900-weight channel ahead of the 100-weight one",
			counts)
	}
}

// TestUnderSampledChannelStaysInContention is how a new channel earns its
// samples. Excluding it until it is measured is a deadlock: it is never chosen,
// so it is never measured.
func TestUnderSampledChannelStaysInContention(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "measured", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "newcomer", []string{"m"}, 100, 100, true)

	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 50, 50, 50, 50, 50)
	// Two samples, and slow ones: still below the minimum, so still unmeasured.
	recordSamples(tracker, 2, 4000, 4000)

	counts := countSelections(t, database, tracker, ptr("m"), 400)
	if counts["newcomer"] == 0 {
		t.Errorf("counts = %v, want the under-sampled channel still routable", counts)
	}
}

// TestLowSampleCountDoesNotFlapTheDecision is the flapping case: a channel whose
// samples arrive one at a time must not take over routing on the strength of its
// first lucky response and hand it back on its second.
func TestLowSampleCountDoesNotFlapTheDecision(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "steady", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "erratic", []string{"m"}, 100, 100, true)

	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 100, 100, 100, 100, 100, 100)

	// One very fast response, then a slow one, then fast again. While the count is
	// under the minimum none of it may rank the channel at all, so the steady
	// channel's reading is the only usable one throughout.
	for _, sample := range []int32{5, 9000, 5} {
		recordSamples(tracker, 2, sample)
		if reading := tracker.Read(2); reading.Usable {
			t.Fatalf("a channel with %d samples was ranked", reading.SampleCount)
		}
		if reading := tracker.Read(1); !reading.Usable || reading.MedianMs != 100 {
			t.Errorf("the steady channel's reading moved to %+v", reading)
		}
	}

	// Once it does cross the minimum, it is its median that decides — not the 5ms
	// response that arrived first.
	recordSamples(tracker, 2, 9000, 9000)
	reading := tracker.Read(2)
	if !reading.Usable {
		t.Fatal("the channel never became usable")
	}
	if reading.MedianMs < 1000 {
		t.Errorf("MedianMs = %d, want the slow majority to decide", reading.MedianMs)
	}
	counts := countSelections(t, database, tracker, ptr("m"), 200)
	if counts["erratic"] != 0 {
		t.Errorf("the erratic channel won %d decisions once measured as slow",
			counts["erratic"])
	}
}

// TestPriorityOutranksLatency is the Priority combination the checklist asks for.
// A backup tier exists to be used when the tier above it is unavailable, not when
// it happens to answer faster — a cheap primary and a fast expensive fallback is
// the ordinary reason to configure two tiers at all.
func TestPriorityOutranksLatency(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "primary", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "backup", []string{"m"}, 1, 100, true)

	tracker := NewLatencyTracker()
	// The backup is an order of magnitude faster, and must still not be chosen.
	recordSamples(tracker, 1, 900, 910, 890, 905, 895)
	recordSamples(tracker, 2, 30, 31, 29, 30, 30)

	counts := countSelections(t, database, tracker, ptr("m"), 200)
	if counts["backup"] != 0 {
		t.Errorf("the lower-priority channel won %d of 200 decisions on latency alone",
			counts["backup"])
	}
	if counts["primary"] != 200 {
		t.Errorf("primary won %d of 200, want all", counts["primary"])
	}
}

// TestLatencyRanksWithinOneTierOnly checks the other half of that rule: inside
// the winning tier latency decides, and the tier below is untouched by it.
func TestLatencyRanksWithinOneTierOnly(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "primary-slow", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "primary-fast", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "backup", []string{"m"}, 1, 100, true)

	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 900, 910, 890, 905, 895)
	recordSamples(tracker, 2, 60, 61, 59, 60, 60)
	recordSamples(tracker, 3, 20, 21, 19, 20, 20)

	counts := countSelections(t, database, tracker, ptr("m"), 200)
	if counts["primary-fast"] != 200 {
		t.Errorf("counts = %v, want every decision on the fast channel of the top tier",
			counts)
	}
}

// TestWeightedStrategyIgnoresLatency keeps the default strategy default. An
// operator who has not asked for least-latency routing must not get it because a
// tracker happens to be wired in.
func TestWeightedStrategyIgnoresLatency(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "fast", []string{"m"}, 100, 100, true)
	insertUpstream(t, database, "slow", []string{"m"}, 100, 100, true)

	tracker := NewLatencyTracker()
	recordSamples(tracker, 1, 20, 20, 20, 20, 20)
	recordSamples(tracker, 2, 4000, 4000, 4000, 4000, 4000)

	counts := map[string]int{}
	for i := 0; i < 400; i++ {
		selection, err := SelectUpstream(context.Background(), database, NewRoutingCache(),
			NewAutoWeightManager(), testPolicy(),
			SelectionPolicy{Strategy: models.LoadBalanceWeighted, Latency: tracker},
			nil, ptr("m"), models.DefaultGroupID, nil)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		counts[selection.Upstream.Name]++
	}
	if counts["slow"] == 0 {
		t.Errorf("counts = %v, want weighted selection to ignore the latency data", counts)
	}
}

// TestDefaultStrategyIsWeighted keeps the settings default aligned with the
// routing default, so an existing deployment's behaviour does not change on
// upgrade.
func TestDefaultStrategyIsWeighted(t *testing.T) {
	settings := models.DefaultRuntimeSettings()
	if settings.LoadBalanceStrategy != models.LoadBalanceWeighted {
		t.Errorf("default strategy = %q, want %q",
			settings.LoadBalanceStrategy, models.LoadBalanceWeighted)
	}
	if (SelectionPolicy{Strategy: settings.LoadBalanceStrategy}).leastLatency() {
		t.Error("the default strategy ranks by latency")
	}
}
