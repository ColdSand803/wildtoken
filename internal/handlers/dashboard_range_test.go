package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestParseDashboardRangeBuildsUTCDateBounds(t *testing.T) {
	selection, err := parseDashboardRange("custom", "2026-08-01", "2026-08-01", "default")
	if err != nil {
		t.Fatalf("parse custom range: %v", err)
	}
	if selection.Window != db.LogTopWindowCustom || selection.Label != "2026-08-01 至 2026-08-01" {
		t.Fatalf("selection = %+v", selection)
	}
	start := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.Local)
	end := start.AddDate(0, 0, 1)
	if selection.StartAt != start.UTC().Format(models.TimestampFormat) {
		t.Errorf("start_at = %q, want %q", selection.StartAt, start.UTC().Format(models.TimestampFormat))
	}
	if selection.EndAt != end.UTC().Format(models.TimestampFormat) {
		t.Errorf("end_at = %q, want %q", selection.EndAt, end.UTC().Format(models.TimestampFormat))
	}
}

func TestParseDashboardRangeRejectsInvalidCustomDates(t *testing.T) {
	testCases := []struct {
		name  string
		start string
		end   string
	}{
		{name: "missing start", end: "2026-08-01"},
		{name: "invalid format", start: "2026/08/01", end: "2026-08-01"},
		{name: "reversed", start: "2026-08-02", end: "2026-08-01"},
		{name: "too wide", start: "2026-01-01", end: "2027-01-02"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := parseDashboardRange("custom", testCase.start, testCase.end, "default"); err == nil {
				t.Fatal("invalid custom range was accepted")
			}
		})
	}
}

func TestDashboardHandlersAcceptSharedTimeRanges(t *testing.T) {
	state := upstreamTestState(t)
	if _, err := state.DB.Exec(`INSERT INTO request_logs
        (id, created_at, method, path, client_type, upstream_model, stream, total_tokens) VALUES
        (1, datetime('now', '-90 days'), 'POST', '/v1/r', 'codex', 'gpt-test', 0, 10),
        (2, datetime('now'), 'POST', '/v1/r', 'codex', 'gpt-test', 0, 20)`); err != nil {
		t.Fatalf("insert logs: %v", err)
	}
	cache, err := db.LoadLogStatsCache(t.Context(), state.DB)
	if err != nil {
		t.Fatalf("load log stats: %v", err)
	}
	state.LogStats = cache

	request := httptest.NewRequest(http.MethodGet,
		"/api/admin/logs/token-usage?range=all", nil)
	recorder := httptest.NewRecorder()
	AdminTokenUsageStats(state).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("all-time token usage returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var usage models.TokenUsageStatsOut
	if err := json.Unmarshal(recorder.Body.Bytes(), &usage); err != nil {
		t.Fatalf("decode token usage: %v", err)
	}
	if usage.Range != "all" || usage.Today.TotalTokens != 30 {
		t.Errorf("all-time token usage = %+v", usage)
	}

	today := time.Now().In(time.Local).Format(dashboardDateLayout)
	topPaths := []string{
		"/api/admin/logs/top?window=all",
		"/api/admin/logs/top?window=default",
		"/api/admin/logs/top?window=custom&start_date=" + today + "&end_date=" + today,
	}
	for _, path := range topPaths {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			recorder := httptest.NewRecorder()
			AdminTopLogStats(state).ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("top stats returned %d: %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
