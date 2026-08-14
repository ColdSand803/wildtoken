package proxy

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
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
	writer := NewLogWriter(ctx, database, runtimeMetrics, db.NewLogStatsCache(), 64)
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
