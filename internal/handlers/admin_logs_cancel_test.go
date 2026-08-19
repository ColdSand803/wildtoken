package handlers

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/appstate"
)

// seedLogsForCancel fills enough rows that an unindexed search takes long enough
// for a cancellation to land while the query is running.
func seedLogsForCancel(t *testing.T, state *appstate.State) {
	t.Helper()

	tx, err := state.DB.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback()

	for index := 0; index < 40000; index++ {
		_, err := tx.Exec(`INSERT INTO request_logs
		    (created_at, method, path, client_type, stream, status_code,
		     upstream_name, duration_ms)
		    VALUES ('2026-08-18 10:00:00', 'POST', '/v1/chat', 'test', 0, 200, ?, 120)`,
			fmt.Sprintf("channel-%d", index))
		if err != nil {
			t.Fatalf("insert %d: %v", index, err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// TestAbandonedLogListingDoesNotOutliveItsRequest is the handler half of the
// range-switch race: the console cancels a superseded load, and the request it
// abandoned must stop rather than run to completion holding a connection.
//
// The pool the console draws from is the one forwarded requests use, so a
// listing that ignored cancellation would not merely waste work — it would make
// a rapid series of range switches contend with the proxy path.
func TestAbandonedLogListingDoesNotOutliveItsRequest(t *testing.T) {
	state := upstreamTestState(t)
	seedLogsForCancel(t, state)

	// A term matching nothing is the slow case: LIMIT bounds the rows returned,
	// not the rows examined, so this reads the whole table.
	target := "/api/admin/logs?search=nothingmatchesthisterm"

	// The uncancelled cost is measured in the same run, so the comparison below
	// does not depend on how fast this machine is.
	baselineStart := time.Now()
	baselineRecorder := httptest.NewRecorder()
	AdminListLogs(state).ServeHTTP(baselineRecorder,
		httptest.NewRequest(http.MethodGet, target, nil))
	baseline := time.Since(baselineStart)
	if baselineRecorder.Code != http.StatusOK {
		t.Fatalf("baseline listing returned %d: %s",
			baselineRecorder.Code, baselineRecorder.Body.String())
	}

	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, target, nil).WithContext(ctx)
	recorder := httptest.NewRecorder()

	go func() {
		time.Sleep(2 * time.Millisecond)
		cancel()
	}()

	started := time.Now()
	AdminListLogs(state).ServeHTTP(recorder, request)
	elapsed := time.Since(started)

	// Half the baseline is a loose bound on purpose: the two figures are far
	// apart in practice, so this catches a handler that ran to completion without
	// making ordinary scheduling noise a failure.
	if elapsed > baseline/2 {
		t.Errorf("abandoned listing took %v against a %v baseline: it ignored the cancellation",
			elapsed, baseline)
	}
	if recorder.Code == http.StatusOK {
		t.Error("an abandoned listing answered 200, so it finished the work anyway")
	}

	// The connection must be back. With a single-connection pool a leak is not a
	// slow degradation: the next request could never acquire one.
	followUp := httptest.NewRecorder()
	AdminListLogs(state).ServeHTTP(followUp,
		httptest.NewRequest(http.MethodGet, "/api/admin/logs?limit=5", nil))
	if followUp.Code != http.StatusOK {
		t.Fatalf("follow-up listing returned %d, connection was not released: %s",
			followUp.Code, followUp.Body.String())
	}
	if inUse := state.DB.Stats().InUse; inUse != 0 {
		t.Errorf("%d connections still in use after the abandoned request", inUse)
	}
}

// TestCancelledDashboardEndpointsStayAvailableAfterwards covers the endpoints a
// range switch reloads together. Each is its own query path, and the property
// under test is that abandoning one leaves the next request serviceable.
func TestCancelledDashboardEndpointsStayAvailableAfterwards(t *testing.T) {
	endpoints := []struct {
		name    string
		target  string
		handler func(*appstate.State) http.HandlerFunc
	}{
		{"overview", "/api/admin/logs/overview?range=all", AdminLogOverview},
		{"top stats", "/api/admin/logs/top?window=all", AdminTopLogStats},
		// A custom range on purpose. Preset windows are served from the in-memory
		// stats snapshot and never reach SQLite, so `range=all` would pass this
		// test without exercising cancellation at all; only a custom range calls
		// QueryTokenUsage.
		{
			"token usage",
			"/api/admin/token-usage?range=custom&start_date=2026-08-01&end_date=2026-08-18",
			AdminTokenUsageStats,
		},
		{"upstream health", "/api/admin/upstreams/health", AdminUpstreamHealthHistory},
	}

	for _, endpoint := range endpoints {
		t.Run(endpoint.name, func(t *testing.T) {
			state := upstreamTestState(t)

			// Already cancelled rather than raced: these aggregate over the whole
			// table and several finish faster than a reliable race against them
			// can be arranged. What is pinned is that cancellation is honoured and
			// the endpoint remains serviceable, not how far it got.
			ctx, cancel := context.WithCancel(context.Background())
			cancel()

			recorder := httptest.NewRecorder()
			endpoint.handler(state).ServeHTTP(recorder,
				httptest.NewRequest(http.MethodGet, endpoint.target, nil).WithContext(ctx))

			if recorder.Code == http.StatusOK {
				t.Errorf("%s answered 200 for a cancelled request", endpoint.name)
			}

			followUp := httptest.NewRecorder()
			endpoint.handler(state).ServeHTTP(followUp,
				httptest.NewRequest(http.MethodGet, endpoint.target, nil))
			if followUp.Code != http.StatusOK {
				t.Fatalf("%s returned %d after a cancelled request: %s",
					endpoint.name, followUp.Code, followUp.Body.String())
			}
			if inUse := state.DB.Stats().InUse; inUse != 0 {
				t.Errorf("%s left %d connections in use", endpoint.name, inUse)
			}
		})
	}
}

// TestACancelledListingIsNotReportedAsAnEmptyPage is the failure mode that would
// be worst for the console: a cancelled query answering 200 with zero rows.
//
// The range-switch guard discards responses from superseded generations, but a
// 200-with-no-rows arriving for the *current* generation would render as "no logs
// match" — an empty result the operator would read as a fact about their traffic
// rather than as a request that never completed.
func TestACancelledListingIsNotReportedAsAnEmptyPage(t *testing.T) {
	state := upstreamTestState(t)

	if _, err := state.DB.Exec(`INSERT INTO request_logs
	    (id, created_at, method, path, client_type, stream, status_code, duration_ms)
	    VALUES (1, '2026-08-18 10:00:00', 'POST', '/v1/chat', 'test', 0, 200, 90)`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	recorder := httptest.NewRecorder()
	AdminListLogs(state).ServeHTTP(recorder,
		httptest.NewRequest(http.MethodGet, "/api/admin/logs", nil).WithContext(ctx))

	if recorder.Code == http.StatusOK {
		t.Fatalf("a cancelled listing answered 200 with body %s: an incomplete "+
			"query is indistinguishable from an empty result set",
			recorder.Body.String())
	}
}
