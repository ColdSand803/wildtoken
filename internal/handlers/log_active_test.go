package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
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
