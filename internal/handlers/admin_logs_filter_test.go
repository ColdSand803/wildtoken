package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// TestAdminListLogsAppliesStatusAndTokenFilters proves the frozen query
// contract reaches the database: each status class selects its own rows, and a
// token drill-down uses the stable ID rather than the display name.
func TestAdminListLogsAppliesStatusAndTokenFilters(t *testing.T) {
	state := upstreamTestState(t)

	if _, err := state.DB.Exec(`INSERT INTO upstreams (id, name, base_url)
        VALUES (1, 'primary', 'https://example.test')`); err != nil {
		t.Fatalf("seed upstream: %v", err)
	}
	if _, err := state.DB.Exec(`INSERT INTO api_tokens (id, name, token, token_hash, token_preview)
        VALUES (10, 'token-a', 'tok-a', 'hash-a', 'preview'),
               (20, 'token-b', 'tok-b', 'hash-b', 'preview')`); err != nil {
		t.Fatalf("seed tokens: %v", err)
	}

	// Both token rows snapshot the same display name, so only the ID can
	// separate them. Status codes cover 2xx/other/4xx/499/5xx/NULL.
	if _, err := state.DB.Exec(`INSERT INTO request_logs
        (id, created_at, method, path, client_type, upstream_id,
         downstream_token_id, downstream_token_name, stream, status_code)
        VALUES
        (1, datetime('now', '-1 minutes'), 'POST', '/v1/chat', 'test', 1, 10, 'shared', 0, 200),
        (2, datetime('now', '-2 minutes'), 'POST', '/v1/chat', 'test', 1, 10, 'shared', 0, 302),
        (3, datetime('now', '-3 minutes'), 'POST', '/v1/chat', 'test', 1, 20, 'shared', 0, 404),
        (4, datetime('now', '-4 minutes'), 'POST', '/v1/chat', 'test', 1, 20, 'shared', 0, 499),
        (5, datetime('now', '-5 minutes'), 'POST', '/v1/chat', 'test', 1, 20, 'shared', 0, 502),
        (6, datetime('now', '-6 minutes'), 'POST', '/v1/chat', 'test', 1, 20, 'shared', 0, NULL)`); err != nil {
		t.Fatalf("seed logs: %v", err)
	}

	listIDs := func(t *testing.T, query string) []int64 {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/admin/logs/"+query, nil)
		recorder := httptest.NewRecorder()
		AdminListLogs(state).ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s returned %d: %s", query, recorder.Code, recorder.Body.String())
		}
		var page models.RequestLogPage
		if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
			t.Fatalf("decode %s: %v", query, err)
		}
		ids := make([]int64, 0, len(page.Items))
		for _, item := range page.Items {
			ids = append(ids, item.ID)
		}
		return ids
	}

	testCases := []struct {
		query   string
		wantIDs []int64
	}{
		{query: "?status=2xx", wantIDs: []int64{1}},
		{query: "?status=4xx", wantIDs: []int64{3, 4}},
		{query: "?status=5xx", wantIDs: []int64{5}},
		{query: "?status=other", wantIDs: []int64{2}},
		{query: "?status=none", wantIDs: []int64{6}},
		{query: "?status=error", wantIDs: []int64{2, 3, 4, 5, 6}},
		{query: "?downstream_token_id=10", wantIDs: []int64{1, 2}},
		{query: "?downstream_token_id=20", wantIDs: []int64{3, 4, 5, 6}},
		{query: "?downstream_token_id=20&status=error", wantIDs: []int64{3, 4, 5, 6}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.query, func(t *testing.T) {
			got := listIDs(t, testCase.query)
			if len(got) != len(testCase.wantIDs) {
				t.Fatalf("%s matched %v, want %v", testCase.query, got, testCase.wantIDs)
			}
			seen := map[int64]bool{}
			for _, id := range got {
				seen[id] = true
			}
			for _, want := range testCase.wantIDs {
				if !seen[want] {
					t.Fatalf("%s matched %v, want %v", testCase.query, got, testCase.wantIDs)
				}
			}
		})
	}
}

// TestAdminListLogsRejectsUnknownStatus keeps an unknown status from silently
// returning every row: the dashboard and the log view have to fail loudly when
// they disagree about the enum rather than show an unfiltered list.
func TestAdminListLogsRejectsUnknownStatus(t *testing.T) {
	state := upstreamTestState(t)

	for _, status := range []string{"3xx", "", "ERROR", "2xx%20"} {
		t.Run("status="+status, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet,
				"/api/admin/logs/?status="+status, nil)
			recorder := httptest.NewRecorder()
			AdminListLogs(state).ServeHTTP(recorder, request)
			if status == "2xx%20" {
				// A trailing space is trimmed, not rejected.
				if recorder.Code != http.StatusOK {
					t.Fatalf("trimmed status returned %d: %s", recorder.Code, recorder.Body.String())
				}
				return
			}
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%q returned %d, want 400: %s",
					status, recorder.Code, recorder.Body.String())
			}
		})
	}
}
