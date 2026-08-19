package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"
)

// cancellationRowCount is enough rows that an unindexed leading-wildcard search
// takes long enough for a cancellation to land mid-flight rather than before the
// query starts. An already-cancelled context tests a different thing: that the
// call refuses to begin. This file tests that it gives up once running.
const cancellationRowCount = 40000

// seedRowsForCancellation fills request_logs in one transaction, which is what
// keeps the fixture cheap enough to build per test.
func seedRowsForCancellation(t *testing.T, database *sql.DB) {
	t.Helper()
	ctx := context.Background()

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback()

	for index := 0; index < cancellationRowCount; index++ {
		_, err := tx.ExecContext(ctx, `INSERT INTO request_logs
		    (created_at, method, path, client_type, stream, status_code,
		     upstream_name, duration_ms, total_tokens)
		    VALUES ('2026-08-18 10:00:00', 'POST', '/v1/chat', 'codex', 0, 200, ?, 120, 40)`,
			fmt.Sprintf("channel-%d", index))
		if err != nil {
			t.Fatalf("insert %d: %v", index, err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// assertPoolRecovered is the property that matters more than any error value: a
// cancelled query must hand its connection back.
//
// The pool holds exactly one connection, so a leak is not a slow degradation
// here — the next query can never acquire one and blocks until this deadline.
// That makes the leak a failure rather than something that only shows up under
// production load.
func assertPoolRecovered(t *testing.T, database *sql.DB) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if _, err := ListLogs(ctx, database, 5, 0, nil, LogFilter{}); err != nil {
		t.Fatalf("query after cancellation failed, connection was not released: %v", err)
	}
	if inUse := database.Stats().InUse; inUse != 0 {
		t.Errorf("%d connections still in use after cancellation", inUse)
	}
}

// cancelDuringQuery runs work with a context cancelled shortly after it starts,
// and reports how long the work took to return.
func cancelDuringQuery(t *testing.T, work func(ctx context.Context) error) (time.Duration, error) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(2 * time.Millisecond)
		cancel()
	}()

	started := time.Now()
	err := work(ctx)
	return time.Since(started), err
}

// TestACancelledListingGivesUpMidFlight covers the client that navigates away
// while a slow listing is running. The existing pre-cancelled test proves the
// call refuses to start; this one proves it abandons work already underway.
func TestACancelledListingGivesUpMidFlight(t *testing.T) {
	database := memoryDB(t)
	seedRowsForCancellation(t, database)

	// A term matching nothing is the slow case: LIMIT bounds rows returned, not
	// rows examined, so this reads the whole table.
	search := "nothingmatchesthisterm"
	filter := LogFilter{Search: &search}

	// The uncancelled cost is measured in the same run rather than hardcoded, so
	// the comparison holds on a machine of any speed.
	baselineStart := time.Now()
	if _, err := ListLogs(context.Background(), database, 50, 0, nil, filter); err != nil {
		t.Fatalf("baseline listing: %v", err)
	}
	baseline := time.Since(baselineStart)

	elapsed, err := cancelDuringQuery(t, func(ctx context.Context) error {
		_, err := ListLogs(ctx, database, 50, 0, nil, filter)
		return err
	})

	if err == nil {
		t.Fatal("a cancelled listing returned as though it had finished")
	}
	// Asserted through errors.Is rather than against a message: the driver's
	// wording is not a contract, but the cause travelling up intact is what lets
	// the handler tell an abandoned request apart from a real database fault.
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error %v does not unwrap to context.Canceled", err)
	}
	// Half the baseline is a deliberately loose bound. The measured figures are
	// far apart (roughly 11ms against 180ms), so this catches a query that ran to
	// completion without turning ordinary scheduling noise into a failure.
	if elapsed > baseline/2 {
		t.Errorf("cancelled listing took %v against a %v baseline: it ran to completion",
			elapsed, baseline)
	}

	assertPoolRecovered(t, database)
}

// TestCancelledAggregationsReleaseTheirConnection covers the endpoints behind a
// range switch. Each is a separate query path, and a leak in any one of them
// would stall the proxy rather than just the console: they draw from the pool
// the forwarded requests use.
func TestCancelledAggregationsReleaseTheirConnection(t *testing.T) {
	database := memoryDB(t)
	seedRowsForCancellation(t, database)

	aggregations := []struct {
		name string
		run  func(ctx context.Context) error
	}{
		{"overview", func(ctx context.Context) error {
			_, err := LogOverview(ctx, database, LogTopWindowAll, "", "")
			return err
		}},
		{"top stats", func(ctx context.Context) error {
			_, err := TopLogStats(ctx, database, LogTopWindowAll, 5)
			return err
		}},
		{"token usage", func(ctx context.Context) error {
			_, err := QueryTokenUsage(ctx, database, LogTopWindowAll, "", "")
			return err
		}},
		{"upstream health", func(ctx context.Context) error {
			_, err := UpstreamHealthHistory(ctx, database, 24, nil)
			return err
		}},
	}

	for _, aggregation := range aggregations {
		t.Run(aggregation.name, func(t *testing.T) {
			// An already-cancelled context is used here rather than a mid-flight
			// cancel: these aggregate over the whole table and some complete
			// faster than a race against them can be made reliable. What is being
			// pinned is that cancellation is honoured and the connection comes
			// back, not how far into the work it got.
			ctx, cancel := context.WithCancel(context.Background())
			cancel()

			err := aggregation.run(ctx)
			if err == nil {
				t.Fatalf("%s ignored a cancelled context", aggregation.name)
			}
			if !errors.Is(err, context.Canceled) {
				t.Errorf("%s error %v does not unwrap to context.Canceled",
					aggregation.name, err)
			}
			assertPoolRecovered(t, database)
		})
	}
}

// TestLogQueryTimeoutIsBoundedByItsOwnDeadline pins the guarantee LogQueryTimeout
// exists for: a caller that never cancels still gets an answer, because the
// listing carries its own deadline.
//
// A one-nanosecond parent deadline stands in for the ten-second one expiring.
// Waiting out the real timeout would put ten seconds into every run to observe
// the same branch.
func TestLogQueryTimeoutIsBoundedByItsOwnDeadline(t *testing.T) {
	database := memoryDB(t)

	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(time.Millisecond)

	_, err := ListLogs(ctx, database, 50, 0, nil, LogFilter{})
	if err == nil {
		t.Fatal("a listing past its deadline returned as though it had finished")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error %v does not unwrap to context.DeadlineExceeded", err)
	}

	assertPoolRecovered(t, database)
}

// TestACancelledDetailLookupDoesNotStrandItsConnection covers the one read path
// a drill-down uses that is not a listing: opening a row's detail.
func TestACancelledDetailLookupDoesNotStrandItsConnection(t *testing.T) {
	database := memoryDB(t)

	if _, err := database.Exec(`INSERT INTO request_logs
	    (id, created_at, method, path, client_type, stream, status_code, duration_ms)
	    VALUES (1, '2026-08-18 10:00:00', 'POST', '/v1/chat', 'codex', 0, 200, 90)`); err != nil {
		t.Fatalf("insert: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := GetLogDetail(ctx, database, 1)
	if err == nil {
		t.Fatal("a cancelled detail lookup returned as though it had finished")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error %v does not unwrap to context.Canceled", err)
	}

	assertPoolRecovered(t, database)

	// The row is still readable afterwards: cancellation must not have been
	// mistaken for a missing row, which is what would make a drill-down report
	// the log as deleted.
	detail, ok, err := GetLogDetail(context.Background(), database, 1)
	if err != nil || !ok {
		t.Fatalf("detail unavailable after a cancelled lookup: err=%v ok=%v", err, ok)
	}
	if detail.ID != 1 {
		t.Errorf("detail id = %d, want 1", detail.ID)
	}
}
