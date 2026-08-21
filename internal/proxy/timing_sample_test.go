package proxy

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// loggedTiming is the waterfall's sample points as they were persisted.
type loggedTiming struct {
	requestUID        sql.NullString
	attemptIndex      sql.NullInt64
	preUpstreamMs     sql.NullInt64
	upstreamHeadersMs sql.NullInt64
	firstTokenMs      sql.NullInt64
	durationMs        sql.NullInt64
	statusCode        sql.NullInt64
}

// readTiming drains the writer and returns the single row it wrote.
func readTiming(t *testing.T, harness *proxyHarness) loggedTiming {
	t.Helper()
	harness.deps.LogWriter.Close()

	var timing loggedTiming
	err := harness.database.QueryRow(`SELECT request_uid, attempt_index,
	    pre_upstream_ms, upstream_headers_ms, first_token_ms, duration_ms, status_code
	    FROM request_logs ORDER BY id DESC LIMIT 1`).Scan(&timing.requestUID,
		&timing.attemptIndex, &timing.preUpstreamMs, &timing.upstreamHeadersMs,
		&timing.firstTokenMs, &timing.durationMs, &timing.statusCode)
	if err != nil {
		t.Fatalf("read timing: %v", err)
	}
	return timing
}

func timingUpstream(t *testing.T, harness *proxyHarness, baseURL string) models.UpstreamRow {
	t.Helper()
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: baseURL,
		ExtraHeaders:      "{}",
		AutoWeightEnabled: 1, Enabled: 1,
	}
	harness.registerUpstream(t, &upstream)
	return upstream
}

func timingRequestContext(receivedAt time.Time, attempt int32) RequestContext {
	requestCtx := testRequestContext()
	requestCtx.RequestUID = "abc123"
	requestCtx.AttemptIndex = attempt
	requestCtx.ReceivedAt = receivedAt
	return requestCtx
}

func prepareFor(t *testing.T, upstream *models.UpstreamRow, requestCtx RequestContext) *PreparedRequest {
	t.Helper()
	prepared, err := PrepareRequest(http.Header{}, upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m"}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	return prepared
}

// TestBufferedResponseRecordsHeaderArrival covers the point the checklist added
// this field for: a non-streaming answer still reveals when its headers came
// back, which is what separates a slow connection from a slow upstream.
func TestBufferedResponseRecordsHeaderArrival(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(30 * time.Millisecond)
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)

	receivedAt := time.Now().Add(-40 * time.Millisecond)
	requestCtx := timingRequestContext(receivedAt, 0)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	response.Body.Close()

	timing := readTiming(t, harness)
	if !timing.upstreamHeadersMs.Valid {
		t.Fatal("upstream_headers_ms is NULL for a response whose headers arrived")
	}
	if timing.upstreamHeadersMs.Int64 < 20 {
		t.Errorf("upstream_headers_ms = %d, want at least the upstream's 30ms delay",
			timing.upstreamHeadersMs.Int64)
	}
	// The header sample shares the attempt's origin with duration, so it can
	// never exceed it. A field measured from a different origin would show up
	// here as a header arrival after the response completed.
	if timing.durationMs.Valid && timing.upstreamHeadersMs.Int64 > timing.durationMs.Int64 {
		t.Errorf("upstream_headers_ms %d exceeds duration_ms %d: origins disagree",
			timing.upstreamHeadersMs.Int64, timing.durationMs.Int64)
	}
	if !timing.preUpstreamMs.Valid {
		t.Fatal("pre_upstream_ms is NULL despite a sampled ReceivedAt")
	}
	// Measured from an origin 40ms in the past, so the gateway's own share is at
	// least that, and it excludes the upstream's 30ms.
	if timing.preUpstreamMs.Int64 < 35 {
		t.Errorf("pre_upstream_ms = %d, want at least the 40ms before the attempt",
			timing.preUpstreamMs.Int64)
	}
	if uid := timing.requestUID; !uid.Valid || uid.String != "abc123" {
		t.Errorf("request_uid = %+v, want abc123", uid)
	}
	if idx := timing.attemptIndex; !idx.Valid || idx.Int64 != 0 {
		t.Errorf("attempt_index = %+v, want 0", idx)
	}
}

// TestStreamRecordsHeadersBeforeFirstToken is the ordering the waterfall relies
// on: headers, then the first visible token, then completion. If these were
// sampled from different origins the stages would not nest.
func TestStreamRecordsHeadersBeforeFirstToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()

		// The gap between headers and the first token is what the two fields
		// have to be able to tell apart.
		time.Sleep(40 * time.Millisecond)
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))
		w.(http.Flusher).Flush()
		w.Write([]byte("data: [DONE]\n\n"))
		w.(http.Flusher).Flush()
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)

	requestCtx := timingRequestContext(time.Now(), 0)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatalf("read stream: %v", err)
	}
	response.Body.Close()

	timing := readTiming(t, harness)
	if !timing.upstreamHeadersMs.Valid {
		t.Fatal("upstream_headers_ms is NULL for a stream that sent headers")
	}
	if !timing.firstTokenMs.Valid {
		t.Fatal("first_token_ms is NULL for a stream that sent a visible token")
	}
	if timing.upstreamHeadersMs.Int64 > timing.firstTokenMs.Int64 {
		t.Errorf("headers at %dms after first token at %dms: stages do not nest",
			timing.upstreamHeadersMs.Int64, timing.firstTokenMs.Int64)
	}
	if timing.firstTokenMs.Int64 > timing.durationMs.Int64 {
		t.Errorf("first token at %dms after completion at %dms",
			timing.firstTokenMs.Int64, timing.durationMs.Int64)
	}
	// The upstream held the stream open for 40ms before the token, so the two
	// samples must actually differ rather than both landing on header arrival.
	if timing.firstTokenMs.Int64-timing.upstreamHeadersMs.Int64 < 30 {
		t.Errorf("first token %dms and headers %dms are too close to be distinct samples",
			timing.firstTokenMs.Int64, timing.upstreamHeadersMs.Int64)
	}
}

// TestTransportFailureLeavesHeaderSampleNull is the case a filled-in default
// would misreport: no headers ever arrived, so claiming a header time would say
// the channel answered when it never did.
func TestTransportFailureLeavesHeaderSampleNull(t *testing.T) {
	harness := newProxyHarness(t)
	// A port nothing listens on: Do fails before any response exists.
	upstream := timingUpstream(t, harness, "http://127.0.0.1:1")
	upstream.TimeoutSeconds = 2

	requestCtx := timingRequestContext(time.Now().Add(-15*time.Millisecond), 0)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err == nil {
		response.Body.Close()
		t.Fatal("expected a transport failure")
	}

	timing := readTiming(t, harness)
	if timing.upstreamHeadersMs.Valid {
		t.Errorf("upstream_headers_ms = %d for a request that never got headers",
			timing.upstreamHeadersMs.Int64)
	}
	// The gateway's own share is still known, and so is how fast the failure
	// came back: dropping both would make "unreachable" and "never attempted"
	// identical in the log.
	if !timing.preUpstreamMs.Valid {
		t.Error("pre_upstream_ms is NULL on a transport failure")
	}
	if !timing.durationMs.Valid {
		t.Error("duration_ms is NULL on a transport failure")
	}
}

// TestUnsampledOriginLeavesPreUpstreamNull keeps a caller that does not track
// the request's start out of the data. A zero time would otherwise be measured
// against, reporting decades of gateway latency.
func TestUnsampledOriginLeavesPreUpstreamNull(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)

	// testRequestContext leaves ReceivedAt, RequestUID and AttemptIndex unset,
	// which is what a non-proxy caller looks like.
	requestCtx := testRequestContext()
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	response.Body.Close()

	timing := readTiming(t, harness)
	if timing.preUpstreamMs.Valid {
		t.Errorf("pre_upstream_ms = %d for an unsampled origin, want NULL",
			timing.preUpstreamMs.Int64)
	}
	if timing.requestUID.Valid {
		t.Errorf("request_uid = %q for a caller that supplied none, want NULL",
			timing.requestUID.String)
	}
}

// TestPreUpstreamMsClampsAndSkips covers the two shapes the helper must not pass
// through: an unset origin, and one from after the attempt began.
func TestPreUpstreamMsClampsAndSkips(t *testing.T) {
	if got := preUpstreamMs(time.Time{}, time.Now()); got != nil {
		t.Errorf("unset origin produced %d, want nil", *got)
	}

	start := time.Now()
	// An origin 50ms after the attempt started cannot describe a real interval.
	got := preUpstreamMs(start.Add(50*time.Millisecond), start)
	if got == nil {
		t.Fatal("a sampled origin produced nil")
	}
	if *got != 0 {
		t.Errorf("reversed interval produced %d, want it clamped to 0", *got)
	}

	got = preUpstreamMs(start.Add(-120*time.Millisecond), start)
	if got == nil || *got < 100 {
		t.Errorf("120ms before the attempt produced %v, want about 120", got)
	}
}
