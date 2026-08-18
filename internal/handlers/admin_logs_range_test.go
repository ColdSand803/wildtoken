package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// logsRangeState seeds rows at known instants, including ones on either side of
// a UTC day boundary, so a timezone mistake in the range parsing surfaces as the
// wrong row set rather than a plausible one.
func logsRangeState(t *testing.T) *appstate.State {
	t.Helper()
	state := upstreamTestState(t)

	if _, err := state.DB.Exec(`INSERT INTO request_logs
        (id, created_at, method, path, client_type, stream, status_code, duration_ms)
        VALUES
        (1, '2026-08-17 23:59:59', 'POST', '/v1/chat', 'test', 0, 200, 50),
        (2, '2026-08-18 00:00:00', 'POST', '/v1/chat', 'test', 1, 200, 0),
        (3, '2026-08-18 06:30:00', 'POST', '/v1/chat', 'test', 1, 200, 3000),
        (4, '2026-08-18 12:00:00', 'POST', '/v1/chat', 'test', 0, 200, NULL),
        (5, '2026-08-18 23:59:59', 'POST', '/v1/chat', 'test', 1, 200, 10500),
        (6, '2026-08-19 00:00:00', 'POST', '/v1/chat', 'test', 0, 200, 120)`); err != nil {
		t.Fatalf("seed logs: %v", err)
	}
	return state
}

// listLogIDs runs the query against the list endpoint and returns the row IDs.
func listLogIDs(t *testing.T, state *appstate.State, query string) []int64 {
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

func sameIDSet(got, want []int64) bool {
	if len(got) != len(want) {
		return false
	}
	seen := map[int64]int{}
	for _, id := range got {
		seen[id]++
	}
	for _, id := range want {
		seen[id]--
	}
	for _, count := range seen {
		if count != 0 {
			return false
		}
	}
	return true
}

// TestAdminListLogsAppliesTimeRange covers the RFC3339 contract, including the
// case worth guarding: created_at is stored as 'YYYY-MM-DD HH:MM:SS' in UTC, so
// an offset timestamp has to be converted rather than compared as written. A
// literal string compare against '2026-08-18T08:00:00+08:00' would match nothing
// while looking like a working filter.
func TestAdminListLogsAppliesTimeRange(t *testing.T) {
	state := logsRangeState(t)

	testCases := []struct {
		name    string
		query   string
		wantIDs []int64
	}{
		{
			name:    "utc day, start inclusive and end exclusive",
			query:   "?start=2026-08-18T00:00:00Z&end=2026-08-19T00:00:00Z",
			wantIDs: []int64{2, 3, 4, 5},
		},
		{
			// 08:00+08:00 is 00:00Z: the same instant as the case above, written
			// in a zone. It must select the same rows.
			name:    "offset timestamps resolve to the same instant",
			query:   "?start=2026-08-18T08:00:00%2B08:00&end=2026-08-19T08:00:00%2B08:00",
			wantIDs: []int64{2, 3, 4, 5},
		},
		{
			name:    "narrow window",
			query:   "?start=2026-08-18T06:30:00Z&end=2026-08-18T06:30:01Z",
			wantIDs: []int64{3},
		},
		{
			name:    "range combined with a threshold",
			query:   "?start=2026-08-18T00:00:00Z&end=2026-08-19T00:00:00Z&min_duration_ms=3000",
			wantIDs: []int64{3, 5},
		},
		{
			name:    "range combined with stream",
			query:   "?start=2026-08-18T00:00:00Z&end=2026-08-19T00:00:00Z&stream=false",
			wantIDs: []int64{4},
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			got := listLogIDs(t, state, testCase.query)
			if !sameIDSet(got, testCase.wantIDs) {
				t.Errorf("%s matched %v, want %v", testCase.query, got, testCase.wantIDs)
			}
		})
	}
}

// TestAdminListLogsAppliesStreamAndDurationFilters pins the P0-B3 filters at the
// handler boundary, including the untimed row that must stay out of any latency
// threshold.
func TestAdminListLogsAppliesStreamAndDurationFilters(t *testing.T) {
	state := logsRangeState(t)

	testCases := []struct {
		query   string
		wantIDs []int64
	}{
		{query: "?stream=true", wantIDs: []int64{2, 3, 5}},
		{query: "?stream=1", wantIDs: []int64{2, 3, 5}},
		{query: "?stream=false", wantIDs: []int64{1, 4, 6}},
		{query: "?min_duration_ms=0", wantIDs: []int64{1, 2, 3, 5, 6}},
		{query: "?min_duration_ms=3000", wantIDs: []int64{3, 5}},
		{query: "?min_duration_ms=10000", wantIDs: []int64{5}},
		{query: "?stream=true&min_duration_ms=3000", wantIDs: []int64{3, 5}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.query, func(t *testing.T) {
			got := listLogIDs(t, state, testCase.query)
			if !sameIDSet(got, testCase.wantIDs) {
				t.Errorf("%s matched %v, want %v", testCase.query, got, testCase.wantIDs)
			}
		})
	}
}

// TestAdminListLogsRejectsInvalidRangeAndThreshold checks that a malformed
// filter fails loudly. Returning the unfiltered page instead would put a full
// list under a UI claiming a filter is active, which reads as "nothing matched
// the narrower query" when the query never ran.
func TestAdminListLogsRejectsInvalidRangeAndThreshold(t *testing.T) {
	state := logsRangeState(t)

	testCases := []struct {
		name  string
		query string
	}{
		{name: "start without end", query: "?start=2026-08-18T00:00:00Z"},
		{name: "end without start", query: "?end=2026-08-19T00:00:00Z"},
		{name: "start equals end", query: "?start=2026-08-18T00:00:00Z&end=2026-08-18T00:00:00Z"},
		{name: "reversed range", query: "?start=2026-08-19T00:00:00Z&end=2026-08-18T00:00:00Z"},
		{name: "non rfc3339 start", query: "?start=2026-08-18&end=2026-08-19T00:00:00Z"},
		{
			name:  "storage shape is not accepted",
			query: "?start=2026-08-18+00:00:00&end=2026-08-19+00:00:00",
		},
		{name: "span over the ceiling", query: "?start=2020-01-01T00:00:00Z&end=2026-08-19T00:00:00Z"},
		{name: "threshold not a number", query: "?min_duration_ms=abc"},
		{name: "negative threshold", query: "?min_duration_ms=-1"},
		{name: "stream not a bool", query: "?stream=yes-please"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/admin/logs/"+testCase.query, nil)
			recorder := httptest.NewRecorder()
			AdminListLogs(state).ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest {
				t.Errorf("%s returned %d, want 400: %s",
					testCase.query, recorder.Code, recorder.Body.String())
			}
		})
	}
}

// TestParseLogFilterContract exercises the parser both the paginated list and
// the live stream read their filters through.
//
// It is tested here rather than through the stream endpoint because that handler
// checks admin auth first and the context key is private to the middleware
// package, so an unauthenticated request never reaches the parsing. Covering the
// shared function directly is what actually pins the contract the two endpoints
// have in common.
func TestParseLogFilterContract(t *testing.T) {
	mustParse := func(t *testing.T, rawQuery string) db.LogFilter {
		t.Helper()
		values, err := url.ParseQuery(rawQuery)
		if err != nil {
			t.Fatalf("parse query %q: %v", rawQuery, err)
		}
		filter, err := parseLogFilter(values)
		if err != nil {
			t.Fatalf("parse filter %q: %v", rawQuery, err)
		}
		return filter
	}

	t.Run("normalizes an offset range to storage shape", func(t *testing.T) {
		filter := mustParse(t, "start=2026-08-18T08:00:00%2B08:00&end=2026-08-19T08:00:00%2B08:00")
		if filter.Start == nil || filter.End == nil {
			t.Fatal("range did not survive parsing")
		}
		if *filter.Start != "2026-08-18 00:00:00" {
			t.Errorf("start = %q, want the UTC storage shape", *filter.Start)
		}
		if *filter.End != "2026-08-19 00:00:00" {
			t.Errorf("end = %q, want the UTC storage shape", *filter.End)
		}
	})

	t.Run("absent range leaves both bounds unset", func(t *testing.T) {
		filter := mustParse(t, "status=error")
		if filter.Start != nil || filter.End != nil {
			t.Errorf("bounds = %v..%v, want unset", filter.Start, filter.End)
		}
	})

	t.Run("stream and threshold", func(t *testing.T) {
		filter := mustParse(t, "stream=true&min_duration_ms=3000")
		if filter.Stream == nil || !*filter.Stream {
			t.Errorf("stream = %v, want true", filter.Stream)
		}
		if filter.MinDurationMs == nil || *filter.MinDurationMs != 3000 {
			t.Errorf("min_duration_ms = %v, want 3000", filter.MinDurationMs)
		}
	})

	t.Run("rejects what the list rejects", func(t *testing.T) {
		for _, rawQuery := range []string{
			"start=2026-08-18T00:00:00Z",
			"end=2026-08-19T00:00:00Z",
			"start=2026-08-19T00:00:00Z&end=2026-08-18T00:00:00Z",
			"start=2026-08-18&end=2026-08-19T00:00:00Z",
			"min_duration_ms=abc",
			"min_duration_ms=-1",
			"stream=nope",
			"status=3xx",
		} {
			values, err := url.ParseQuery(rawQuery)
			if err != nil {
				t.Fatalf("parse query %q: %v", rawQuery, err)
			}
			if _, err := parseLogFilter(values); err == nil {
				t.Errorf("%q was accepted, want rejection", rawQuery)
			}
		}
	})
}

// TestOpenEndedForLiveStream pins the one place the stream and the list
// deliberately differ.
//
// The console forwards a dashboard preset's resolved range to both endpoints. On
// the stream, an end of "now" would filter out every event that arrives after
// the connection, leaving the log view permanently quiet with nothing to explain
// it. A range that has genuinely closed must still be honoured, or a historical
// view starts mixing in live traffic.
func TestOpenEndedForLiveStream(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	shape := func(value time.Time) *string {
		formatted := value.UTC().Format(models.TimestampFormat)
		return &formatted
	}

	testCases := []struct {
		name       string
		end        *string
		wantOpened bool
	}{
		{
			name: "preset ending now becomes open ended",
			end:  shape(now), wantOpened: true,
		},
		{
			name: "end rounded just past now becomes open ended",
			end:  shape(now.Add(time.Second)), wantOpened: true,
		},
		{
			name: "closed historical window keeps its bound",
			end:  shape(now.Add(-24 * time.Hour)), wantOpened: false,
		},
		{
			name: "no bound stays absent",
			end:  nil, wantOpened: true,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			start := "2026-08-17 12:00:00"
			filter := db.LogFilter{Start: &start, End: testCase.end}
			got := openEndedForLiveStream(filter, now)

			if testCase.wantOpened && got.End != nil {
				t.Errorf("end = %q, want dropped so live events still arrive", *got.End)
			}
			if !testCase.wantOpened && got.End == nil {
				t.Error("a closed historical window lost its upper bound")
			}
			// The lower bound is never touched: it is what keeps a historical
			// view from receiving events older than the window.
			if got.Start == nil || *got.Start != start {
				t.Errorf("start = %v, want it preserved as %q", got.Start, start)
			}
		})
	}
}

// TestLiveStreamFilterAdmitsEventsAfterConnection is the regression this fix
// exists for: an event logged after a preset drill-down must still match.
func TestLiveStreamFilterAdmitsEventsAfterConnection(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

	// What the dashboard resolves for a live preset: a window ending at now.
	values, err := url.ParseQuery(
		"start=2026-08-17T12:00:00Z&end=2026-08-18T12:00:00Z")
	if err != nil {
		t.Fatalf("parse query: %v", err)
	}
	filter, err := parseLogFilter(values)
	if err != nil {
		t.Fatalf("parse filter: %v", err)
	}

	arriving := models.RequestLogOut{
		ID:        1,
		CreatedAt: now.Add(30 * time.Second).UTC().Format(models.TimestampFormat),
	}

	// The list endpoint's filter legitimately excludes it: that window closed.
	if filter.Matches(arriving) {
		t.Error("the paginated window matched an event past its end")
	}

	// The stream's must not, or live tailing dies silently at the drill-down.
	if !openEndedForLiveStream(filter, now).Matches(arriving) {
		t.Error("live stream dropped an event that arrived after connecting")
	}

	// An event older than the window is still excluded on the stream.
	stale := models.RequestLogOut{
		ID:        2,
		CreatedAt: "2026-08-16 12:00:00",
	}
	if openEndedForLiveStream(filter, now).Matches(stale) {
		t.Error("live stream admitted an event older than the window")
	}
}

// TestLogOverviewReportsResolvedRange checks the drill-down handoff: a preset
// window has no instants of its own, so the overview resolves them and the
// console echoes the pair back verbatim. The values must therefore be in the
// shape the log endpoint accepts.
func TestLogOverviewReportsResolvedRange(t *testing.T) {
	state := logsRangeState(t)

	fetch := func(t *testing.T, query string) map[string]any {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/admin/logs/overview"+query, nil)
		recorder := httptest.NewRecorder()
		AdminLogOverview(state).ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s returned %d: %s", query, recorder.Code, recorder.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %s: %v", query, err)
		}
		return payload
	}

	t.Run("preset resolves to instants the log endpoint accepts", func(t *testing.T) {
		payload := fetch(t, "?range=1d")
		start, startOK := payload["resolved_start"].(string)
		end, endOK := payload["resolved_end"].(string)
		if !startOK || !endOK {
			t.Fatalf("resolved range missing: %v / %v",
				payload["resolved_start"], payload["resolved_end"])
		}
		// The contract is that the console forwards these untouched, so they
		// have to survive a round trip through the log endpoint's own parsing.
		if _, _, err := parseLogRange(start, end); err != nil {
			t.Errorf("resolved range %s..%s rejected by the log endpoint: %v", start, end, err)
		}
	})

	t.Run("custom range echoes its own bounds", func(t *testing.T) {
		payload := fetch(t, "?range=custom&start_date=2026-08-18&end_date=2026-08-18")
		start, _ := payload["resolved_start"].(string)
		end, _ := payload["resolved_end"].(string)
		if start == "" || end == "" {
			t.Fatalf("custom range did not resolve: %v / %v",
				payload["resolved_start"], payload["resolved_end"])
		}
		if _, _, err := parseLogRange(start, end); err != nil {
			t.Errorf("resolved range %s..%s rejected by the log endpoint: %v", start, end, err)
		}
	})

	t.Run("all time has no bounds", func(t *testing.T) {
		payload := fetch(t, "?range=all")
		if payload["resolved_start"] != nil || payload["resolved_end"] != nil {
			t.Errorf("range=all resolved to %v..%v, want null bounds",
				payload["resolved_start"], payload["resolved_end"])
		}
	})
}
