package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// readRouting calls the endpoint and decodes it as the console will.
func readRouting(t *testing.T, state *appstate.State) models.UpstreamRoutingOut {
	t.Helper()
	recorder := httptest.NewRecorder()
	AdminUpstreamsRouting(state)(recorder,
		httptest.NewRequest(http.MethodGet, "/api/admin/upstreams/routing", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}

	var routing models.UpstreamRoutingOut
	if err := json.Unmarshal(recorder.Body.Bytes(), &routing); err != nil {
		t.Fatalf("decode routing: %v", err)
	}
	return routing
}

func routingState(t *testing.T) *appstate.State {
	t.Helper()
	state := upstreamTestState(t)
	state.Latency = proxy.NewLatencyTracker()
	return state
}

func recordLatency(tracker *proxy.LatencyTracker, upstreamID int64, samples ...int32) {
	for _, sample := range samples {
		value := sample
		tracker.Record(upstreamID, &value)
	}
}

// TestRoutingEndpointPublishesTheRuleConstants is what the console renders as
// "当前策略与回退规则". The numbers are code constants, and publishing them is what
// keeps the console from carrying a second copy that can drift.
func TestRoutingEndpointPublishesTheRuleConstants(t *testing.T) {
	routing := readRouting(t, routingState(t))

	if routing.Rules.MinSamples != proxy.LatencyMinSamples {
		t.Errorf("min_samples = %d, want %d", routing.Rules.MinSamples, proxy.LatencyMinSamples)
	}
	if routing.Rules.SampleCapacity != proxy.LatencySampleCapacity {
		t.Errorf("sample_capacity = %d, want %d",
			routing.Rules.SampleCapacity, proxy.LatencySampleCapacity)
	}
	if want := int64(proxy.LatencyStaleWindow.Seconds()); routing.Rules.StaleWindowSeconds != want {
		t.Errorf("stale_window_seconds = %d, want %d", routing.Rules.StaleWindowSeconds, want)
	}
	if routing.Rules.ToleranceRatio != proxy.LatencyToleranceRatio {
		t.Errorf("tolerance_ratio = %v, want %v",
			routing.Rules.ToleranceRatio, proxy.LatencyToleranceRatio)
	}
	if routing.Rules.ToleranceFloorMs != proxy.LatencyToleranceFloorMs {
		t.Errorf("tolerance_floor_ms = %d, want %d",
			routing.Rules.ToleranceFloorMs, proxy.LatencyToleranceFloorMs)
	}
}

// TestRoutingEndpointReportsTheDefaultStrategyAsInactive keeps the console from
// presenting a latency column that decides nothing. Samples are collected under
// both strategies; only one of them routes on them.
func TestRoutingEndpointReportsTheDefaultStrategyAsInactive(t *testing.T) {
	state := routingState(t)
	routing := readRouting(t, state)

	if routing.Strategy != models.LoadBalanceWeighted {
		t.Errorf("strategy = %q, want the default %q",
			routing.Strategy, models.LoadBalanceWeighted)
	}
	if routing.LatencyActive {
		t.Error("latency_active is true under the weighted strategy")
	}

	settings := state.Runtime.Get()
	settings.LoadBalanceStrategy = models.LoadBalanceLeastLatency
	state.Runtime.Set(settings)

	routing = readRouting(t, state)
	if routing.Strategy != models.LoadBalanceLeastLatency || !routing.LatencyActive {
		t.Errorf("routing = %+v, want the least-latency strategy reported as active", routing)
	}
}

// TestRoutingEndpointSeparatesNoSamplesFromTooFew is the distinction the channel
// card needs: a channel nobody has called is absent, and one that is still
// collecting reports its count with a null median.
func TestRoutingEndpointSeparatesNoSamplesFromTooFew(t *testing.T) {
	state := routingState(t)
	// Two samples: measured, but not enough to rank.
	recordLatency(state.Latency, 7, 120, 130)
	// Enough to rank.
	recordLatency(state.Latency, 9, 50, 52, 48, 51, 49)

	routing := readRouting(t, state)
	if len(routing.Latency) != 2 {
		t.Fatalf("reported %d channels, want only the two with samples", len(routing.Latency))
	}
	// Ordered by id so a polling console does not see rows jump between refreshes.
	if routing.Latency[0].UpstreamID != 7 || routing.Latency[1].UpstreamID != 9 {
		t.Fatalf("ids = (%d, %d), want them ordered",
			routing.Latency[0].UpstreamID, routing.Latency[1].UpstreamID)
	}

	collecting := routing.Latency[0]
	if collecting.Usable {
		t.Error("a 2-sample channel is reported as usable")
	}
	if collecting.MedianMs != nil {
		t.Errorf("median_ms = %d on an under-sampled channel, want null", *collecting.MedianMs)
	}
	if collecting.SampleCount != 2 {
		t.Errorf("sample_count = %d, want 2 so the console can show progress",
			collecting.SampleCount)
	}

	ranked := routing.Latency[1]
	if !ranked.Usable || ranked.MedianMs == nil {
		t.Fatalf("ranked channel = %+v, want a usable median", ranked)
	}
	if *ranked.MedianMs != 50 {
		t.Errorf("median_ms = %d, want 50", *ranked.MedianMs)
	}
}

// TestRoutingEndpointWithoutATrackerIsEmptyRatherThanBroken keeps the endpoint
// answering on a state assembled without a tracker. An empty list is the correct
// answer — no samples exist — and a panic here would take the channels page down.
func TestRoutingEndpointWithoutATrackerIsEmptyRatherThanBroken(t *testing.T) {
	state := upstreamTestState(t)
	routing := readRouting(t, state)
	if len(routing.Latency) != 0 {
		t.Errorf("reported %d channels with no tracker wired", len(routing.Latency))
	}
	// The rules are constants, so they are still worth answering with.
	if routing.Rules.MinSamples != proxy.LatencyMinSamples {
		t.Errorf("min_samples = %d, want the constant even with no tracker",
			routing.Rules.MinSamples)
	}
}

// TestRoutingEndpointDropsChannelsWhoseSamplesExpired keeps an idle channel from
// being reported with a stale figure. Routing would not use it, so the console
// must not show it as the channel's current speed.
func TestRoutingEndpointDropsChannelsWhoseSamplesExpired(t *testing.T) {
	state := routingState(t)
	recordLatency(state.Latency, 3, 50, 50, 50, 50, 50)
	if routing := readRouting(t, state); len(routing.Latency) != 1 {
		t.Fatalf("fresh samples were not reported: %+v", routing.Latency)
	}

	state.Latency.Reset(3)
	if routing := readRouting(t, state); len(routing.Latency) != 0 {
		t.Errorf("reported %d channels after the history was dropped",
			len(routing.Latency))
	}
}

// TestSameModelMappingsComparesStoredJSONWithSubmittedMap covers the comparison
// an update relies on to decide whether a channel's measurements still describe
// it. Unparseable storage reports a difference: re-collecting samples is cheap,
// ranking a channel on a mapping it no longer has is not.
func TestSameModelMappingsComparesStoredJSONWithSubmittedMap(t *testing.T) {
	for name, testCase := range map[string]struct {
		stored   string
		incoming map[string]string
		want     bool
	}{
		"both empty":       {"{}", map[string]string{}, true},
		"identical":        {`{"a":"b"}`, map[string]string{"a": "b"}, true},
		"value changed":    {`{"a":"b"}`, map[string]string{"a": "c"}, false},
		"key added":        {`{"a":"b"}`, map[string]string{"a": "b", "c": "d"}, false},
		"key removed":      {`{"a":"b","c":"d"}`, map[string]string{"a": "b"}, false},
		"key renamed":      {`{"a":"b"}`, map[string]string{"z": "b"}, false},
		"unparseable":      {"not json", map[string]string{}, false},
		"cleared mappings": {`{"a":"b"}`, nil, false},
	} {
		t.Run(name, func(t *testing.T) {
			if got := sameModelMappings(testCase.stored, testCase.incoming); got != testCase.want {
				t.Errorf("sameModelMappings(%q, %v) = %v, want %v",
					testCase.stored, testCase.incoming, got, testCase.want)
			}
		})
	}
}
