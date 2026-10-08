package proxy

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/quota"
)

// proxyHarness wires the dependencies a forwarded request needs.
type proxyHarness struct {
	deps     Deps
	database *sql.DB
	metrics  *metrics.Runtime
}

func newProxyHarness(t *testing.T) *proxyHarness {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+t.Name()+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { database.Close() })
	if err := db.Init(context.Background(), database); err != nil {
		t.Fatalf("init: %v", err)
	}

	runtimeMetrics := metrics.New()
	ctx, cancel := context.WithCancel(context.Background())
	writer := NewLogWriter(ctx, database, runtimeMetrics, db.NewLogStatsCache(), 64, quota.NewTracker(), nil)
	t.Cleanup(func() {
		writer.Close()
		cancel()
	})

	return &proxyHarness{
		deps: Deps{
			HTTPClient:     &http.Client{},
			AutoWeight:     NewAutoWeightManager(),
			Metrics:        runtimeMetrics,
			LogWriter:      writer,
			DefaultTimeout: 30 * time.Second,
		},
		database: database,
		metrics:  runtimeMetrics,
	}
}

func (h *proxyHarness) waitForLogs(t *testing.T, want int64) {
	t.Helper()
	h.deps.LogWriter.Close()

	var count int64
	if err := h.database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
		t.Fatalf("count logs: %v", err)
	}
	if count != want {
		t.Fatalf("wrote %d logs, want %d", count, want)
	}
}

// registerUpstream inserts the channel row the request log's foreign key needs.
func (h *proxyHarness) registerUpstream(t *testing.T, upstream *models.UpstreamRow) {
	t.Helper()
	_, err := h.database.Exec(
		"INSERT INTO upstreams (id, name, base_url) VALUES (?, ?, ?)",
		upstream.ID, upstream.Name, upstream.BaseURL)
	if err != nil {
		t.Fatalf("register upstream: %v", err)
	}

	// request_logs also references api_tokens, so the caller's token must exist.
	_, err = h.database.Exec(`INSERT INTO api_tokens (id, name, token, token_hash, token_preview)
        VALUES (1, 'client', 'digest', 'digest', '…') ON CONFLICT(id) DO NOTHING`)
	if err != nil {
		t.Fatalf("register token: %v", err)
	}
}

func testRequestContext() RequestContext {
	return RequestContext{
		DownstreamTokenID:   1,
		DownstreamTokenName: "client",
		ClientType:          "codex",
		Method:              http.MethodPost,
		Path:                "responses",
		LogBodyMaxBytes:     200000,
	}
}

func TestChannelOverridesReachTheUpstreamOnTheWire(t *testing.T) {
	received := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	key := "upstream-secret"
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL, APIKey: &key,
		ExtraHeaders: `{"X-API-Key":"overridden-upstream-key","Anthropic-Version":"2025-01-01",` +
			`"User-Agent":"channel-agent","X-Client-Request":"{client_header:X-Request-Id}"}`,
		AutoWeightEnabled: 1, Enabled: 1,
	}

	harness.registerUpstream(t, &upstream)

	downstream := http.Header{}
	downstream.Set("x-request-id", "request-456")
	downstream.Set("authorization", "Bearer downstream-secret")

	requestCtx := testRequestContext()
	requestCtx.Path = "messages"
	prepared, err := PrepareRequest(downstream, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m"}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()

	if response.Status != http.StatusOK {
		t.Errorf("status = %d, want 200", response.Status)
	}

	headers := <-received
	for name, want := range map[string]string{
		"X-Api-Key":         "overridden-upstream-key",
		"Anthropic-Version": "2025-01-01",
		"User-Agent":        "channel-agent",
		"X-Client-Request":  "request-456",
		"Accept-Encoding":   "identity",
	} {
		if got := headers.Get(name); got != want {
			t.Errorf("upstream %s = %q, want %q", name, got, want)
		}
	}
	// The downstream credential never reaches the upstream.
	if got := headers.Get("Authorization"); got != "" {
		t.Errorf("the downstream authorization was forwarded: %q", got)
	}

	harness.waitForLogs(t, 1)
}

func TestNonSuccessResponsesAreLoggedWithoutDisablingTheChannel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"slow down"}}`))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m"}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()

	// A rejected request is returned to the caller as-is, not turned into an error.
	if response.Status != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", response.Status)
	}

	// The health score drops, but the channel stays enabled; only an operator
	// turns a channel off.
	snapshot := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy())
	if snapshot.Score >= MaxHealthScore {
		t.Errorf("health score = %d, want it reduced by the failure", snapshot.Score)
	}

	harness.waitForLogs(t, 1)
	var statusCode int64
	if err := harness.database.QueryRow(
		"SELECT status_code FROM request_logs WHERE id = 1").Scan(&statusCode); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if statusCode != http.StatusTooManyRequests {
		t.Errorf("logged status = %d, want 429", statusCode)
	}
}

func TestStreamingResponseLogsUsageAfterTheStreamCompletes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"usage\":" +
			"{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n"))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m","stream":true}`),
		requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	if !IsSSEContentType(response.Headers["content-type"]) {
		t.Fatalf("content type = %q, want a stream", response.Headers["content-type"])
	}

	// The log is only written once the body has been consumed and closed.
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	response.Body.Close()
	if len(body) == 0 {
		t.Error("the stream forwarded no bytes downstream")
	}

	harness.waitForLogs(t, 1)

	var stream, statusCode, promptTokens, completionTokens, totalTokens int64
	err = harness.database.QueryRow(`SELECT stream, status_code, prompt_tokens,
        completion_tokens, total_tokens FROM request_logs WHERE id = 1`).
		Scan(&stream, &statusCode, &promptTokens, &completionTokens, &totalTokens)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if stream != 1 || statusCode != http.StatusOK {
		t.Errorf("stream=%d status=%d, want 1 and 200", stream, statusCode)
	}
	if promptTokens != 10 || completionTokens != 5 || totalTokens != 15 {
		t.Errorf("usage = %d/%d/%d, want 10/5/15",
			promptTokens, completionTokens, totalTokens)
	}

	if snapshot := harness.metrics.Snapshot(); snapshot.SSECompletedTotal != 1 ||
		snapshot.ActiveSSEStreams != 0 {
		t.Errorf("sse metrics = %d completed / %d active, want 1 and 0",
			snapshot.SSECompletedTotal, snapshot.ActiveSSEStreams)
	}
}

func TestAnAbandonedStreamIsLoggedAsAClientDisconnect(t *testing.T) {
	released := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		// The stream never reaches a terminal event; the client gives up first.
		<-released
	}))
	defer server.Close()
	defer close(released)

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m","stream":true}`),
		requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}

	// Read the first event, then abandon the stream the way a client would.
	buffer := make([]byte, 64)
	if _, err := response.Body.Read(buffer); err != nil {
		t.Fatalf("read first event: %v", err)
	}
	response.Body.Close()

	harness.waitForLogs(t, 1)

	var statusCode int64
	var logError sql.NullString
	if err := harness.database.QueryRow(
		"SELECT status_code, error FROM request_logs WHERE id = 1").
		Scan(&statusCode, &logError); err != nil {
		t.Fatalf("read log: %v", err)
	}
	if statusCode != 499 {
		t.Errorf("status = %d, want 499 for an abandoned stream", statusCode)
	}
	if !logError.Valid || logError.String == "" {
		t.Error("an abandoned stream was logged without an explanation")
	}

	if snapshot := harness.metrics.Snapshot(); snapshot.SSEClientDisconnectsTotal != 1 ||
		snapshot.ActiveSSEStreams != 0 {
		t.Errorf("sse metrics = %d disconnects / %d active, want 1 and 0",
			snapshot.SSEClientDisconnectsTotal, snapshot.ActiveSSEStreams)
	}
}

func TestAnUnreachableUpstreamIsReportedAndCharged(t *testing.T) {
	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel",
		// A port nothing listens on, so the dial fails immediately.
		BaseURL:      "http://127.0.0.1:1",
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m"}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	if _, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared); err == nil {
		t.Fatal("an unreachable upstream did not report an error")
	}

	snapshot := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy())
	if snapshot.Score >= MaxHealthScore {
		t.Errorf("health score = %d, want it reduced by the failure", snapshot.Score)
	}

	harness.waitForLogs(t, 1)
	var statusCode int64
	if err := harness.database.QueryRow(
		"SELECT status_code FROM request_logs WHERE id = 1").Scan(&statusCode); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if statusCode != 502 {
		t.Errorf("status = %d, want 502 for a failed dial", statusCode)
	}
}

func TestAStreamCancelledByTheClientIsNotChargedToTheChannel(t *testing.T) {
	released := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		// The upstream is still working; the client is the one that leaves.
		<-released
	}))
	defer server.Close()
	defer close(released)

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m","stream":true}`),
		requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	response, err := ProxyRequest(ctx, harness.deps, testPolicy(), &upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}

	buffer := make([]byte, 64)
	if _, err := response.Body.Read(buffer); err != nil {
		t.Fatalf("read first event: %v", err)
	}

	// Cancelling while a read is waiting for the next event is where a client
	// walking away actually surfaces: as a read error indistinguishable from an
	// upstream one.
	cancel()
	if _, err := response.Body.Read(buffer); err == nil {
		t.Fatal("the cancelled request did not fail the read")
	}
	response.Body.Close()

	harness.waitForLogs(t, 1)

	var statusCode int64
	if err := harness.database.QueryRow(
		"SELECT status_code FROM request_logs WHERE id = 1").Scan(&statusCode); err != nil {
		t.Fatalf("read log: %v", err)
	}
	if statusCode != 499 {
		t.Errorf("status = %d, want 499 for a client that walked away", statusCode)
	}

	// The channel did nothing wrong. Charging it is what let ordinary use — a
	// user pressing escape — drive a healthy channel's weight to zero.
	health := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy())
	if health.Score != 100 {
		t.Errorf("health score = %d, want 100 after a client cancellation", health.Score)
	}

	snapshot := harness.metrics.Snapshot()
	if snapshot.SSEClientDisconnectsTotal != 1 {
		t.Errorf("client disconnects = %d, want 1", snapshot.SSEClientDisconnectsTotal)
	}
	if snapshot.SSEUpstreamErrorsTotal != 0 {
		t.Errorf("upstream errors = %d, want 0", snapshot.SSEUpstreamErrorsTotal)
	}
}

func TestACompletedStreamIsNotChargedForTheReadThatFollowsIt(t *testing.T) {
	released := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
		w.Write([]byte("data: [DONE]\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		// The answer is complete, but the connection stays open until the
		// attempt's clock runs out — which is what an upstream that does not
		// close after its terminal event looks like.
		<-released
	}))
	defer server.Close()
	defer close(released)

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL, TimeoutSeconds: 0.3,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m","stream":true}`),
		requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}

	buffer := make([]byte, 256)
	for {
		if _, err := response.Body.Read(buffer); err != nil {
			break
		}
	}
	response.Body.Close()

	harness.waitForLogs(t, 1)

	var statusCode int64
	if err := harness.database.QueryRow(
		"SELECT status_code FROM request_logs WHERE id = 1").Scan(&statusCode); err != nil {
		t.Fatalf("read log: %v", err)
	}
	if statusCode != 200 {
		t.Errorf("status = %d, want 200 for a stream that reached its terminal event", statusCode)
	}

	// The log recorded a success, so the health score has to agree. Scoring
	// outside the same guard let one stream be counted as both.
	health := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy())
	if health.Score != 100 {
		t.Errorf("health score = %d, want 100 for a completed stream", health.Score)
	}
}

func TestAChannelThatCannotBuildARequestIsChargedForIt(t *testing.T) {
	harness := newProxyHarness(t)
	// A base URL that survived storage but that the request builder will not
	// accept. Such a channel fails every request it is given, so it has to lose
	// health — otherwise it keeps full weight and keeps being chosen.
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: "http://example.com/\x7f",
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m"}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	if _, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared); err == nil {
		t.Fatal("expected the request build to fail")
	}

	health := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy())
	if health.Score == 100 {
		t.Error("a channel that cannot build a request kept full health")
	}

	// It still leaves a log row, which is what makes the failure visible.
	harness.waitForLogs(t, 1)
}

func TestABufferedResponseTheClientLeftIsLoggedAsAClientAbort(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m"}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	response, err := ProxyRequest(ctx, harness.deps, testPolicy(), &upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}

	// The upstream answered in full, but the client goes before the handler
	// has delivered it. The streaming path records that as a 499; this one
	// used to record the upstream's 200, so the console's client-abort filter
	// showed only the requests that happened to stream.
	cancel()
	response.Body.Close()

	harness.waitForLogs(t, 1)

	var statusCode int64
	var logError sql.NullString
	if err := harness.database.QueryRow(
		"SELECT status_code, error FROM request_logs WHERE id = 1").
		Scan(&statusCode, &logError); err != nil {
		t.Fatalf("read log: %v", err)
	}
	if statusCode != 499 {
		t.Errorf("status = %d, want 499 for a client that left mid-delivery", statusCode)
	}
	if !logError.Valid || logError.String == "" {
		t.Error("the abort was logged without an explanation")
	}
}

func TestABufferedResponseDeliveredInFullKeepsTheUpstreamStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m"}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}

	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if len(body) == 0 {
		t.Error("the buffered body was empty")
	}
	// Closed twice, the way a retry abandoning a response and then the handler
	// writing it out would.
	response.Body.Close()
	response.Body.Close()

	harness.waitForLogs(t, 1)

	var rows int64
	if err := harness.database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 1 {
		t.Errorf("%d log rows, want exactly one", rows)
	}

	var statusCode int64
	var totalTokens sql.NullInt64
	if err := harness.database.QueryRow(
		"SELECT status_code, total_tokens FROM request_logs WHERE id = 1").
		Scan(&statusCode, &totalTokens); err != nil {
		t.Fatalf("read log: %v", err)
	}
	if statusCode != 200 {
		t.Errorf("status = %d, want the upstream's 200", statusCode)
	}
	if !totalTokens.Valid || totalTokens.Int64 != 18 {
		t.Errorf("total tokens = %v, want the usage to survive the deferral", totalTokens)
	}
}

// proxyOnce sends one request through a channel and drains the answer.
func (h *proxyHarness) proxyOnce(t *testing.T, upstream *models.UpstreamRow, path string) *Response {
	t.Helper()
	requestCtx := testRequestContext()
	requestCtx.Path = path
	prepared, err := PrepareRequest(http.Header{}, upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m","stream":true}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	response, err := ProxyRequest(context.Background(), h.deps, testPolicy(), upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	return response
}

// A 4xx other than 408 and 429 may be the request's own fault. Charging it let
// a few requests too long for any model take every channel out of routing.
func TestOnlyChannelFaultsAreChargedAtOnce(t *testing.T) {
	harness := newProxyHarness(t)
	for index, tc := range []struct {
		status  int
		charged bool
	}{
		{http.StatusBadRequest, false},
		{http.StatusNotFound, false},
		{http.StatusUnprocessableEntity, false},
		{http.StatusRequestTimeout, true},
		{http.StatusTooManyRequests, true},
		{http.StatusInternalServerError, true},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
		}))
		upstream := models.UpstreamRow{
			ID: int64(index + 1), Name: server.URL, BaseURL: server.URL,
			ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
		}
		harness.registerUpstream(t, &upstream)
		harness.proxyOnce(t, &upstream, "responses")
		server.Close()

		score := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy()).Score
		if charged := score < MaxHealthScore; charged != tc.charged {
			t.Errorf("status %d: charged=%v, want %v", tc.status, charged, tc.charged)
		}
	}
}

// Anthropic reports input in message_start and output in message_delta, and a
// compatible upstream need not repeat the input in the delta. Keeping only the
// last report logged, and charged, the output alone.
func TestAnAnthropicStreamCountsTheInputItsStartEventCarried(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.Write([]byte("event: message_start\n" +
			`data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":1}}}` + "\n\n" +
			"event: message_delta\n" +
			`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}` + "\n\n" +
			"event: message_stop\n" + `data: {"type":"message_stop"}` + "\n\n"))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "anthropic", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)
	harness.proxyOnce(t, &upstream, "messages")
	harness.waitForLogs(t, 1)

	var prompt, completion, total int64
	if err := harness.database.QueryRow(`SELECT prompt_tokens, completion_tokens, total_tokens
        FROM request_logs WHERE id = 1`).Scan(&prompt, &completion, &total); err != nil {
		t.Fatal(err)
	}
	if prompt != 1200 || completion != 15 || total != 1215 {
		t.Errorf("usage = %d/%d/%d, want 1200/15/1215", prompt, completion, total)
	}
}

// A stream that began as a 200 and ended on an error event failed. It is logged
// as a failure, and the channel is charged only when the error blames it.
func TestAStreamThatEndsOnAnErrorEventIsLoggedAsAFailure(t *testing.T) {
	harness := newProxyHarness(t)
	for index, tc := range []struct {
		event   string
		charged bool
	}{
		{`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, true},
		{`{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}`, false},
		{`{"type":"response.failed","response":{"error":{"code":"server_error","message":"x"}}}`, true},
		{`{"error":{"message":"upstream exploded","type":"server_error"}}`, true},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			w.Write([]byte("data: " + tc.event + "\n\n"))
		}))
		upstream := models.UpstreamRow{
			ID: int64(index + 1), Name: server.URL, BaseURL: server.URL,
			ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
		}
		harness.registerUpstream(t, &upstream)
		harness.proxyOnce(t, &upstream, "messages")
		server.Close()

		score := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy()).Score
		if charged := score < MaxHealthScore; charged != tc.charged {
			t.Errorf("%s: charged=%v, want %v", tc.event, charged, tc.charged)
		}
	}
	harness.waitForLogs(t, 4)

	var failures int64
	if err := harness.database.QueryRow(`SELECT COUNT(*) FROM request_logs
        WHERE status_code = 502 AND error LIKE 'upstream reported an error in the stream%'`).
		Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != 4 {
		t.Errorf("%d of 4 streams were logged as failures", failures)
	}
	if snapshot := harness.metrics.Snapshot(); snapshot.SSECompletedTotal != 0 ||
		snapshot.SSEUpstreamErrorsTotal != 4 {
		t.Errorf("sse metrics = %d completed / %d errors, want 0 / 4",
			snapshot.SSECompletedTotal, snapshot.SSEUpstreamErrorsTotal)
	}
}

// A stream sent as text/plain is still a stream: its usage is read from its
// events, not parsed as one JSON document and found missing.
func TestAStreamWithoutAStreamContentTypeIsStillBilled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain")
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
			"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5," +
			"\"total_tokens\":15}}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m","stream":true}`),
		requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	io.ReadAll(response.Body)
	response.Body.Close()
	harness.waitForLogs(t, 1)

	var stream int64
	var totalTokens sql.NullInt64
	if err := harness.database.QueryRow(`SELECT stream, total_tokens FROM request_logs WHERE id = 1`).
		Scan(&stream, &totalTokens); err != nil {
		t.Fatal(err)
	}
	if stream != 1 || totalTokens.Int64 != 15 {
		t.Errorf("stream=%d total=%v, want a billed stream of 15", stream, totalTokens)
	}
}

// abandonedStream relays one upstream stream, reads its first chunk and closes
// it as a client that left would, returning the log row.
func abandonedStream(t *testing.T, handler http.HandlerFunc, requestBody string,
	timeoutSeconds float64) (status int64, total sql.NullInt64, prompt sql.NullInt64,
	completion sql.NullInt64, message sql.NullString) {
	t.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL, TimeoutSeconds: timeoutSeconds,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)

	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(requestBody), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	clientCtx, leave := context.WithCancel(context.Background())
	response, err := ProxyRequest(clientCtx, harness.deps, testPolicy(), &upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	if _, err := response.Body.Read(make([]byte, 64<<10)); err != nil {
		t.Fatalf("read first chunk: %v", err)
	}
	leave()
	response.Body.Close()
	harness.waitForLogs(t, 1)

	if err := harness.database.QueryRow(`SELECT status_code, total_tokens, prompt_tokens,
        completion_tokens, error FROM request_logs WHERE id = 1`).
		Scan(&status, &total, &prompt, &completion, &message); err != nil {
		t.Fatal(err)
	}
	return status, total, prompt, completion, message
}

// The usage follows the last content. A client that left at the content was
// logged without it and never billed.
func TestAStreamAbandonedBeforeItsUsageIsStillBilled(t *testing.T) {
	status, total, _, _, _ := abandonedStream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n"))
		w.(http.Flusher).Flush()
		time.Sleep(100 * time.Millisecond)
		w.Write([]byte("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5," +
			"\"total_tokens\":15}}\n\ndata: [DONE]\n\n"))
	}, `{"model":"m","stream":true}`, 0)

	if status != 499 || total.Int64 != 15 {
		t.Errorf("status=%d total=%v, want 499 billed at the reported 15", status, total)
	}
}

// With no usage by the time the stream ends, the request is billed on an
// estimate and the log says so.
func TestAStreamAbandonedWithoutUsageIsBilledOnAnEstimate(t *testing.T) {
	status, total, prompt, completion, message := abandonedStream(t,
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"a first part\"}}]}\n\n"))
			w.(http.Flusher).Flush()
			time.Sleep(50 * time.Millisecond)
			w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"and more words that follow\"}}]}\n\n"))
		}, `{"model":"m","stream":true,"messages":[{"role":"user","content":"write something long"}]}`, 0)

	if status != 499 || !total.Valid || total.Int64 != prompt.Int64+completion.Int64 ||
		prompt.Int64 == 0 || completion.Int64 < 8 {
		t.Errorf("status=%d prompt=%v completion=%v total=%v, want an estimate", status, prompt,
			completion, total)
	}
	if !strings.Contains(message.String, "usage estimated") {
		t.Errorf("error = %q, want the estimate noted", message.String)
	}
}

// Anthropic's message_start reports the prompt and a placeholder output of 1.
// The prompt stands; the output is estimated from what streamed.
func TestAnAbandonedMessagesStreamKeepsItsReportedPrompt(t *testing.T) {
	_, total, prompt, completion, _ := abandonedStream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":" +
			"{\"usage\":{\"input_tokens\":100,\"output_tokens\":1}}}\n\n"))
		w.(http.Flusher).Flush()
		time.Sleep(50 * time.Millisecond)
		w.Write([]byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\"," +
			"\"delta\":{\"type\":\"text_delta\",\"text\":\"forty characters of streamed answer text\"}}\n\n"))
	}, `{"model":"m","stream":true}`, 0)

	if prompt.Int64 != 100 || completion.Int64 < 10 || total.Int64 != prompt.Int64+completion.Int64 {
		t.Errorf("prompt=%v completion=%v total=%v, want 100 plus the estimated output",
			prompt, completion, total)
	}
}

// A client reading slowly is not the upstream going quiet: the timeout covers
// only the wait on the upstream.
func TestASlowReaderIsNotAnUpstreamTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		for range 4 {
			w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"))
			w.(http.Flusher).Flush()
			time.Sleep(20 * time.Millisecond)
		}
		w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := models.UpstreamRow{
		ID: 1, Name: "channel", BaseURL: server.URL, TimeoutSeconds: 0.2,
		ExtraHeaders: "{}", AutoWeightEnabled: 1, Enabled: 1, Weight: 100,
	}
	harness.registerUpstream(t, &upstream)
	requestCtx := testRequestContext()
	prepared, err := PrepareRequest(http.Header{}, &upstream, requestCtx.Method,
		requestCtx.Path, "", nil, []byte(`{"model":"m","stream":true}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(), &upstream,
		requestCtx, prepared)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 64)
	for {
		_, err := response.Body.Read(buffer)
		if err != nil {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	response.Body.Close()
	harness.waitForLogs(t, 1)

	var status int64
	if err := harness.database.QueryRow(`SELECT status_code FROM request_logs WHERE id = 1`).
		Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != 200 {
		t.Errorf("status = %d, want 200: the upstream never stalled", status)
	}
}
