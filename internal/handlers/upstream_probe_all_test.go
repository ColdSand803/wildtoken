package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// probeAllState adds the pieces an outbound probe needs to the shared state.
func probeAllState(t *testing.T) *appstate.State {
	t.Helper()
	state := upstreamTestState(t)
	state.HTTPClient = &http.Client{}

	ctx, cancel := context.WithCancel(context.Background())
	state.LogWriter = proxy.NewLogWriter(ctx, state.DB, state.Metrics,
		db.NewLogStatsCache(), 64, state.Quotas)
	t.Cleanup(func() {
		state.LogWriter.Close()
		cancel()
	})
	return state
}

// probeAllResponse is the batch endpoint's payload.
type probeAllResponse struct {
	Total     int                    `json:"total"`
	Probed    int                    `json:"probed"`
	Skipped   int                    `json:"skipped"`
	Succeeded int                    `json:"succeeded"`
	Failed    int                    `json:"failed"`
	Partial   bool                   `json:"partial"`
	Results   []appstate.ProbeResult `json:"results"`
}

func runProbeAll(t *testing.T, state *appstate.State, query string) (*httptest.ResponseRecorder, probeAllResponse) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/admin/upstreams/probe-all"+query, nil)
	recorder := httptest.NewRecorder()
	AdminProbeAllUpstreams(state).ServeHTTP(recorder, request)

	var payload probeAllResponse
	if recorder.Code == http.StatusOK {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode probe-all: %v", err)
		}
	}
	return recorder, payload
}

// resultByID indexes results so assertions do not depend on completion order.
func resultByID(results []appstate.ProbeResult) map[int64]appstate.ProbeResult {
	indexed := map[int64]appstate.ProbeResult{}
	for _, result := range results {
		indexed[result.UpstreamID] = result
	}
	return indexed
}

// TestProbeAllReportsEachChannelIndependently covers the partial-success
// requirement: a reachable channel, an authenticating-but-failing one, and one
// whose endpoint does not exist must each get their own verdict. One channel's
// failure may not become another's.
func TestProbeAllReportsEachChannelIndependently(t *testing.T) {
	state := probeAllState(t)

	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(healthy.Close)

	unauthorized := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"invalid api key"}`))
	}))
	t.Cleanup(unauthorized.Close)

	// A closed listener address: the probe fails at the transport layer rather
	// than returning a status, which is the case a status-only result would drop.
	unreachable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	unreachableURL := unreachable.URL
	unreachable.Close()

	channels := []struct {
		id      int64
		name    string
		baseURL string
	}{
		{1, "healthy", healthy.URL},
		{2, "unauthorized", unauthorized.URL},
		{3, "unreachable", unreachableURL},
	}
	for _, channel := range channels {
		if _, err := state.DB.Exec(`INSERT INTO upstreams (id, name, base_url, enabled, timeout_seconds)
            VALUES (?, ?, ?, 1, 2)`, channel.id, channel.name, channel.baseURL); err != nil {
			t.Fatalf("seed channel %d: %v", channel.id, err)
		}
	}

	recorder, payload := runProbeAll(t, state, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("probe-all returned %d: %s", recorder.Code, recorder.Body.String())
	}
	if payload.Total != 3 || payload.Probed != 3 {
		t.Fatalf("total/probed = %d/%d, want 3/3", payload.Total, payload.Probed)
	}
	if payload.Partial {
		t.Error("run was reported partial despite probing every channel")
	}
	if payload.Succeeded != 1 || payload.Failed != 2 {
		t.Errorf("succeeded/failed = %d/%d, want 1/2", payload.Succeeded, payload.Failed)
	}

	indexed := resultByID(payload.Results)

	if got := indexed[1]; !got.OK || got.StatusCode == nil || *got.StatusCode != 200 {
		t.Errorf("healthy channel = %+v, want ok with 200", got)
	}
	if indexed[1].ErrorSummary != nil {
		t.Errorf("healthy channel carried an error summary: %v", *indexed[1].ErrorSummary)
	}

	failing := indexed[2]
	if failing.OK {
		t.Error("401 channel reported ok")
	}
	if failing.StatusCode == nil || *failing.StatusCode != 401 {
		t.Errorf("401 channel status = %v, want 401", failing.StatusCode)
	}
	if failing.ErrorSummary == nil {
		t.Error("401 channel carried no error summary")
	}

	// A transport failure has no status code but must still report a duration
	// and a summary, or an unreachable channel is indistinguishable from one
	// that was never probed.
	dead := indexed[3]
	if dead.OK {
		t.Error("unreachable channel reported ok")
	}
	if dead.StatusCode != nil {
		t.Errorf("unreachable channel status = %v, want none", *dead.StatusCode)
	}
	if dead.ErrorSummary == nil {
		t.Error("unreachable channel carried no error summary")
	}
	if dead.DurationMs == nil {
		t.Error("unreachable channel carried no duration")
	}

	for id, result := range indexed {
		if result.CheckedAt == "" {
			t.Errorf("channel %d has no checked_at", id)
		}
	}
}

// TestProbeAllSkipsDisabledChannelsByDefault keeps a batch probe from waking
// channels an operator deliberately turned off, while still allowing an opt-in
// for testing one before enabling it.
func TestProbeAllSkipsDisabledChannelsByDefault(t *testing.T) {
	state := probeAllState(t)

	var enabledHits, disabledHits atomic.Int64
	enabled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		enabledHits.Add(1)
		w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(enabled.Close)
	disabled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		disabledHits.Add(1)
		w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(disabled.Close)

	if _, err := state.DB.Exec(`INSERT INTO upstreams (id, name, base_url, enabled, timeout_seconds)
        VALUES (1, 'on', ?, 1, 2), (2, 'off', ?, 0, 2)`, enabled.URL, disabled.URL); err != nil {
		t.Fatalf("seed channels: %v", err)
	}

	_, payload := runProbeAll(t, state, "")
	if payload.Total != 1 || payload.Probed != 1 {
		t.Errorf("default run probed %d of %d, want 1 of 1", payload.Probed, payload.Total)
	}
	if disabledHits.Load() != 0 {
		t.Errorf("disabled channel was probed %d times", disabledHits.Load())
	}

	_, inclusive := runProbeAll(t, state, "?include_disabled=true")
	if inclusive.Total != 2 || inclusive.Probed != 2 {
		t.Errorf("opt-in run probed %d of %d, want 2 of 2", inclusive.Probed, inclusive.Total)
	}
	if disabledHits.Load() != 1 {
		t.Errorf("disabled channel probed %d times under opt-in, want 1", disabledHits.Load())
	}
}

// TestProbeAllRefusesConcurrentRuns pins the duplicate guard. A batch probe
// sends one request per channel, so a double-clicked button would multiply that
// load across every upstream at once.
func TestProbeAllRefusesConcurrentRuns(t *testing.T) {
	state := probeAllState(t)

	if !state.ProbeRuns.TryStart(time.Now()) {
		t.Fatal("a fresh state refused the first run")
	}
	t.Cleanup(state.ProbeRuns.Abandon)

	recorder, _ := runProbeAll(t, state, "")
	if recorder.Code != http.StatusConflict {
		t.Errorf("second concurrent run returned %d, want 409: %s",
			recorder.Code, recorder.Body.String())
	}

	// Once the first run releases the lock, a new one is accepted again --
	// otherwise a single abandoned run would wedge the endpoint permanently.
	state.ProbeRuns.Abandon()
	if !state.ProbeRuns.TryStart(time.Now()) {
		t.Error("run lock was not released")
	}
	state.ProbeRuns.Abandon()
}

// TestProbeAllBoundsConcurrency checks that the worker pool actually caps
// in-flight probes. Without the bound, a board of many channels opens one
// outbound connection per channel simultaneously through the same client the
// proxy path uses.
func TestProbeAllBoundsConcurrency(t *testing.T) {
	state := probeAllState(t)

	var inFlight, peak atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := inFlight.Add(1)
		for {
			observed := peak.Load()
			if current <= observed || peak.CompareAndSwap(observed, current) {
				break
			}
		}
		// Long enough that later probes pile up behind the semaphore rather than
		// finishing before their siblings start.
		time.Sleep(40 * time.Millisecond)
		inFlight.Add(-1)
		w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(server.Close)

	channelCount := probeAllConcurrency * 3
	for i := 1; i <= channelCount; i++ {
		if _, err := state.DB.Exec(`INSERT INTO upstreams (id, name, base_url, enabled, timeout_seconds)
            VALUES (?, ?, ?, 1, 5)`, i, fmt.Sprintf("channel-%d", i), server.URL); err != nil {
			t.Fatalf("seed channel %d: %v", i, err)
		}
	}

	_, payload := runProbeAll(t, state, "")
	if payload.Probed != channelCount {
		t.Errorf("probed %d channels, want %d", payload.Probed, channelCount)
	}
	if payload.Succeeded != channelCount {
		t.Errorf("succeeded = %d, want %d", payload.Succeeded, channelCount)
	}
	if peak.Load() > probeAllConcurrency {
		t.Errorf("peak in-flight probes = %d, want at most %d",
			peak.Load(), probeAllConcurrency)
	}
	// A cap that never filled would make the assertion above vacuous.
	if peak.Load() < 2 {
		t.Errorf("peak in-flight probes = %d, expected the pool to be exercised", peak.Load())
	}
}

// TestProbeAllCachesResultsForReload covers the badge path: the console reads the
// last run on load rather than re-probing every channel on every page view.
func TestProbeAllCachesResultsForReload(t *testing.T) {
	state := probeAllState(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(server.Close)

	if _, err := state.DB.Exec(`INSERT INTO upstreams (id, name, base_url, enabled, timeout_seconds)
        VALUES (1, 'only', ?, 1, 2)`, server.URL); err != nil {
		t.Fatalf("seed channel: %v", err)
	}

	if _, payload := runProbeAll(t, state, ""); payload.Succeeded != 1 {
		t.Fatalf("probe run did not succeed: %+v", payload)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/admin/upstreams/probe-all", nil)
	recorder := httptest.NewRecorder()
	AdminLastProbeResults(state).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("last results returned %d: %s", recorder.Code, recorder.Body.String())
	}

	var cached struct {
		Running   bool                   `json:"running"`
		CheckedAt *string                `json:"checked_at"`
		Results   []appstate.ProbeResult `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &cached); err != nil {
		t.Fatalf("decode cached results: %v", err)
	}
	if cached.Running {
		t.Error("a finished run is still reported as running")
	}
	if cached.CheckedAt == nil {
		t.Error("cached results carry no checked_at")
	}
	if len(cached.Results) != 1 || !cached.Results[0].OK {
		t.Errorf("cached results = %+v, want one ok entry", cached.Results)
	}

	// A deleted channel must not leave its verdict behind: SQLite reuses ids, so
	// the next channel created would inherit this one's status.
	state.ProbeRuns.Forget(1)
	if results, _, _ := state.ProbeRuns.Snapshot(); len(results) != 0 {
		t.Errorf("result survived Forget: %+v", results)
	}
}

// TestProbeAllReportsBrokenChannelConfig covers a channel that fails before any
// request goes out. It has to appear in the report as a failure rather than
// vanish from it.
func TestProbeAllReportsBrokenChannelConfig(t *testing.T) {
	state := probeAllState(t)

	if _, err := state.DB.Exec(`INSERT INTO upstreams
        (id, name, base_url, enabled, timeout_seconds, extra_headers)
        VALUES (1, 'broken', 'https://example.test', 1, 2, 'not json')`); err != nil {
		t.Fatalf("seed channel: %v", err)
	}

	_, payload := runProbeAll(t, state, "")
	if payload.Probed != 1 {
		t.Fatalf("probed %d channels, want 1", payload.Probed)
	}
	result := payload.Results[0]
	if result.OK {
		t.Error("channel with unparseable extra headers reported ok")
	}
	if result.ErrorSummary == nil {
		t.Error("broken channel carried no error summary")
	}
	if result.CheckedAt == "" {
		t.Error("broken channel has no checked_at")
	}
}
