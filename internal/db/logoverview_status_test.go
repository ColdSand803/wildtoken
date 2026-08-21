package db

import (
	"context"
	"testing"
)

// TestLogOverviewErrorDefinitionMatchesStatusFilter is the A1 completion
// criterion in test form: the dashboard's error total, the per-bucket error
// counts behind the error time strip, and the log list's `status=error` filter
// must all resolve to the same set of rows. They were three separate SQL
// expressions, so a 1xx/3xx or a NULL status could be counted by one and not
// the others.
func TestLogOverviewErrorDefinitionMatchesStatusFilter(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// One row per status class the classification has to place: 2xx, a 3xx that
	// is non-2xx but not a failure, a 4xx, a client cancel, a 5xx, and a row
	// that never got a status.
	if _, err := database.Exec(`INSERT INTO request_logs
        (id, created_at, method, path, client_type, stream, status_code, duration_ms)
        VALUES
        (1, datetime('now', '-5 minutes'), 'POST', '/v1/chat', 'test', 0, 200, 10),
        (2, datetime('now', '-6 minutes'), 'POST', '/v1/chat', 'test', 0, 302, 0),
        (3, datetime('now', '-7 minutes'), 'POST', '/v1/chat', 'test', 0, 404, NULL),
        (4, datetime('now', '-8 minutes'), 'POST', '/v1/chat', 'test', 0, 499, 20),
        (5, datetime('now', '-9 minutes'), 'POST', '/v1/chat', 'test', 0, 502, 30),
        (6, datetime('now', '-10 minutes'), 'POST', '/v1/chat', 'test', 0, NULL, NULL)`); err != nil {
		t.Fatalf("seed logs: %v", err)
	}

	overview, err := LogOverview(ctx, database, LogTopWindowOneDay, "", "")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}

	status := LogStatusError
	errorRows, err := ListLogs(ctx, database, 100, 0, nil, LogFilter{Status: &status})
	if err != nil {
		t.Fatalf("list error rows: %v", err)
	}

	// 302, 404, 499, 502 and the missing status are all errors; only the 200 is
	// not.
	if int64(len(errorRows)) != overview.ErrorRequests {
		t.Errorf("status=error returned %d rows, overview reported %d errors",
			len(errorRows), overview.ErrorRequests)
	}
	if overview.ErrorRequests != 5 {
		t.Errorf("error requests = %d, want 5", overview.ErrorRequests)
	}

	var seriesErrors int64
	for _, bucket := range overview.RequestSeries {
		seriesErrors += bucket.Errors
	}
	if seriesErrors != overview.ErrorRequests {
		t.Errorf("series errors = %d, overview errors = %d; the strip and the card must agree",
			seriesErrors, overview.ErrorRequests)
	}

	// The classes partition the window exactly once each: `other` is 1xx/3xx
	// only, `none` is the missing status only, and nothing is double counted.
	if overview.Status2xx != 1 || overview.Status4xx != 2 ||
		overview.Status5xx != 1 || overview.StatusOther != 1 || overview.StatusNone != 1 {
		t.Errorf("status classes = 2xx:%d 4xx:%d 5xx:%d other:%d none:%d, want 1/2/1/1/1",
			overview.Status2xx, overview.Status4xx, overview.Status5xx,
			overview.StatusOther, overview.StatusNone)
	}
	classSum := overview.Status2xx + overview.Status4xx + overview.Status5xx +
		overview.StatusOther + overview.StatusNone
	if classSum != overview.TotalRequests {
		t.Errorf("status classes sum to %d, total is %d", classSum, overview.TotalRequests)
	}

	// A legitimate 0ms sample is a timed sample, so the 302 row counts toward
	// the duration statistics rather than being filtered out as "missing".
	if overview.DurationCount != 4 {
		t.Errorf("duration count = %d, want 4 (0ms is a valid sample)", overview.DurationCount)
	}
	if overview.MinDurationMs != 0 {
		t.Errorf("min duration = %d, want 0", overview.MinDurationMs)
	}
}
