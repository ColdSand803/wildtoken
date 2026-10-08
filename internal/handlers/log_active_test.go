package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
	"github.com/liguangsheng/wildtoken/internal/quota"
)

func activeLogTestState(t *testing.T) *appstate.State {
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

	return &appstate.State{
		DB:             database,
		Settings:       config.Default(),
		AutoWeight:     proxy.NewAutoWeightManager(),
		Runtime:        appstate.NewSettingsStore(models.DefaultRuntimeSettings()),
		Metrics:        metrics.New(),
		ModelsCache:    appstate.NewModelsListCache(),
		Routing:        proxy.NewRoutingCache(),
		ActiveRequests: proxy.NewActiveRegistry(),
		Quotas:         quota.NewTracker(),
		StartedAt:      time.Now(),
	}
}

func listLogsPage(t *testing.T, state *appstate.State, query string) models.RequestLogPage {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/admin/logs?"+query, nil)
	recorder := httptest.NewRecorder()
	AdminListLogs(state)(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("list returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var page models.RequestLogPage
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode page: %v", err)
	}
	return page
}

func TestListLogsReportsInFlightRequestsOnTheNewestPage(t *testing.T) {
	state := activeLogTestState(t)

	request := state.ActiveRequests.Begin("POST", "chat/completions")
	request.SetDownstreamToken(4, "laptop")
	request.SetClientType("codex")
	forward := "gpt-5"
	request.SetUpstream(11, "openrouter", &forward)

	page := listLogsPage(t, state, "limit=50")
	if len(page.Active) != 1 {
		t.Fatalf("expected 1 in-flight request, got %d", len(page.Active))
	}
	if page.Active[0].ClientType != "codex" {
		t.Fatalf("unexpected client type %q", page.Active[0].ClientType)
	}
	if page.Active[0].UpstreamName == nil || *page.Active[0].UpstreamName != "openrouter" {
		t.Fatalf("unexpected channel %+v", page.Active[0].UpstreamName)
	}

	// An in-flight request has no cursor position, so it must not ride along on
	// a page that was reached through one.
	deeper := listLogsPage(t, state,
		"limit=50&before_created_at=2026-01-01+00%3A00%3A00&before_id=999")
	if len(deeper.Active) != 0 {
		t.Fatalf("a cursor page carried %d in-flight requests", len(deeper.Active))
	}
	offsetPage := listLogsPage(t, state, "limit=50&offset=50")
	if len(offsetPage.Active) != 0 {
		t.Fatalf("an offset page carried %d in-flight requests", len(offsetPage.Active))
	}

	request.Release()
	if page := listLogsPage(t, state, "limit=50"); len(page.Active) != 0 {
		t.Fatalf("a finished request is still reported as in flight: %d", len(page.Active))
	}
}

func TestWriteActiveRequestsEmitsAnSSEFrame(t *testing.T) {
	state := activeLogTestState(t)
	request := state.ActiveRequests.Begin("POST", "chat/completions")
	request.SetClientType("claude")

	recorder := httptest.NewRecorder()
	version := writeActiveRequests(recorder, recorder, state)
	if version == 0 {
		t.Fatal("expected a non-zero version for a registered request")
	}

	body := recorder.Body.String()
	prefix := "event: active\ndata: "
	if len(body) <= len(prefix) || body[:len(prefix)] != prefix {
		t.Fatalf("unexpected frame: %q", body)
	}
	if body[len(body)-2:] != "\n\n" {
		t.Fatalf("frame is not terminated: %q", body)
	}

	var payload struct {
		Requests []models.ActiveRequestOut `json:"requests"`
		Total    int                       `json:"total"`
	}
	if err := json.Unmarshal([]byte(body[len(prefix):len(body)-2]), &payload); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	if len(payload.Requests) != 1 || payload.Requests[0].ClientType != "claude" {
		t.Fatalf("unexpected payload: %+v", payload.Requests)
	}
	// The console reads concurrency from the count, because the list is capped.
	if payload.Total != 1 {
		t.Fatalf("expected a total of 1, got %d", payload.Total)
	}
}

// An empty set must still serialize as an array: the console replaces its whole
// list from this frame, so a null would leave the last rows on screen forever.
func TestWriteActiveRequestsEmitsAnEmptyArray(t *testing.T) {
	state := activeLogTestState(t)

	recorder := httptest.NewRecorder()
	writeActiveRequests(recorder, recorder, state)

	const want = "event: active\ndata: {\"requests\":[],\"total\":0}\n\n"
	if got := recorder.Body.String(); got != want {
		t.Fatalf("unexpected frame: %q", got)
	}
}

// The live log never ends on its own. Left open, it held every shutdown for the
// full drain timeout and ended it with an error.
func TestTheLiveLogStreamEndsWhenShutdownBegins(t *testing.T) {
	state := activeLogTestState(t)
	ctx, cancel := context.WithCancel(context.Background())
	state.LogWriter = proxy.NewLogWriter(ctx, state.DB, state.Metrics, db.NewLogStatsCache(), 8,
		state.Quotas, nil)
	t.Cleanup(func() {
		state.LogWriter.Close()
		cancel()
	})

	hash, err := authstate.HashAdminToken("stream-admin-token")
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := authstate.NewCredentials(
		models.AdminCredential{CredentialHash: hash, CredentialVersion: 1}, authstate.NewThrottle())
	if err != nil {
		t.Fatal(err)
	}
	state.Credentials = credentials
	stopping := make(chan struct{})
	state.Stopping = stopping

	handler := middleware.RequireAdmin(credentials, "")(AdminStreamLogs(state))
	request := httptest.NewRequest(http.MethodGet, "/api/admin/logs/stream", nil)
	request.Header.Set("x-admin-token", "stream-admin-token")
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
		close(done)
	}()

	close(stopping)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the live log stream did not end when shutdown began")
	}
}

// stalledConsole stops reading at its first flush until released.
type stalledConsole struct {
	header  http.Header
	mu      sync.Mutex
	body    strings.Builder
	stalled chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *stalledConsole) Header() http.Header { return c.header }
func (c *stalledConsole) WriteHeader(int)     {}

func (c *stalledConsole) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.body.Write(p)
}

func (c *stalledConsole) Flush() {
	c.once.Do(func() {
		close(c.stalled)
		<-c.release
	})
}

func (c *stalledConsole) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.body.String()
}

// A console that falls behind is told to reload. The rows it had no room for
// are never sent; without the resync its list kept the holes silently.
func TestALaggingLogStreamIsToldToResync(t *testing.T) {
	state := activeLogTestState(t)
	ctx, cancel := context.WithCancel(context.Background())
	state.LogWriter = proxy.NewLogWriter(ctx, state.DB, state.Metrics, db.NewLogStatsCache(), 4096,
		state.Quotas, nil)
	t.Cleanup(func() {
		state.LogWriter.Close()
		cancel()
	})

	hash, err := authstate.HashAdminToken("stream-admin-token")
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := authstate.NewCredentials(
		models.AdminCredential{CredentialHash: hash, CredentialVersion: 1}, authstate.NewThrottle())
	if err != nil {
		t.Fatal(err)
	}
	state.Credentials = credentials
	stopping := make(chan struct{})
	state.Stopping = stopping

	handler := middleware.RequireAdmin(credentials, "")(AdminStreamLogs(state))
	request := httptest.NewRequest(http.MethodGet, "/api/admin/logs/stream", nil)
	request.Header.Set("x-admin-token", "stream-admin-token")
	console := &stalledConsole{header: http.Header{}, stalled: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(console, request)
		close(done)
	}()
	defer func() {
		close(stopping)
		<-done
	}()

	// Subscribed and stalled: commit more rows than its buffer holds.
	<-console.stalled
	const rows = 1100
	for range rows {
		state.LogWriter.Schedule(proxy.LogEntry{Method: "POST", Path: "/v1/responses"})
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var count int
		if err := state.DB.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == rows {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d rows committed", count, rows)
		}
		time.Sleep(10 * time.Millisecond)
	}

	close(console.release)
	for !strings.Contains(console.String(), "event: resync\ndata: {}\n\n") {
		if time.Now().After(deadline) {
			t.Fatal("the stream never told the lagging console to resync")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The rates change as the minute slides, with or without new logs. Sent only
// with logs, they froze at the last one's figures once traffic stopped.
func TestTheLiveLogStreamRefreshesItsRates(t *testing.T) {
	previous := rateRefreshInterval
	rateRefreshInterval = 20 * time.Millisecond
	t.Cleanup(func() { rateRefreshInterval = previous })

	state := activeLogTestState(t)
	ctx, cancel := context.WithCancel(context.Background())
	state.LogWriter = proxy.NewLogWriter(ctx, state.DB, state.Metrics, db.NewLogStatsCache(), 8,
		state.Quotas, nil)
	t.Cleanup(func() {
		state.LogWriter.Close()
		cancel()
	})
	if _, err := state.DB.Exec(`INSERT INTO request_logs
        (created_at, method, path, client_type, stream, status_code, total_tokens)
        VALUES (datetime('now'), 'POST', 'r', 'codex', 0, 200, 42)`); err != nil {
		t.Fatal(err)
	}

	hash, err := authstate.HashAdminToken("stream-admin-token")
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := authstate.NewCredentials(
		models.AdminCredential{CredentialHash: hash, CredentialVersion: 1}, authstate.NewThrottle())
	if err != nil {
		t.Fatal(err)
	}
	state.Credentials = credentials
	stopping := make(chan struct{})
	state.Stopping = stopping

	handler := middleware.RequireAdmin(credentials, "")(AdminStreamLogs(state))
	request := httptest.NewRequest(http.MethodGet, "/api/admin/logs/stream", nil)
	request.Header.Set("x-admin-token", "stream-admin-token")
	console := &stalledConsole{header: http.Header{}, stalled: make(chan struct{}), release: make(chan struct{})}
	close(console.release)
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(console, request)
		close(done)
	}()
	defer func() {
		close(stopping)
		<-done
	}()

	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(console.String(), `event: rate`+"\n"+`data: {"recent_rpm":1,"recent_tpm":42}`) {
		if time.Now().After(deadline) {
			t.Fatalf("no rate event: %q", console.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
