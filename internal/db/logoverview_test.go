package db

import (
	"context"
	"testing"
	"time"
)

// TestLogOverviewAggregatesTheSelectedWindow guards the dashboard's switch
// from "the most recent ~200 loaded logs" to range-scoped SQL aggregates: the
// KPI cards, status buckets, and latency series must all honor the window and
// classify errors exactly the way the console used to (no status, or any
// non-2xx, is an error).
func TestLogOverviewAggregatesTheSelectedWindow(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// Inside the 1d window: a 2xx with duration, a 5xx with duration, a 4xx
	// without one, and a row that never got a status. At -30h: a row that only
	// the 1d window's *previous* period may count. At -10 days: an old 2xx that
	// only the "all" window may count.
	if _, err := database.Exec(`INSERT INTO request_logs
	        (created_at, method, path, client_type, stream, status_code, duration_ms)
	    VALUES
	        (datetime('now', '-10 minutes'), 'POST', '/v1/chat', 'test', 0, 200, 1000),
	        (datetime('now', '-2 hours'),    'POST', '/v1/chat', 'test', 0, 502, 3000),
	        (datetime('now', '-3 hours'),    'POST', '/v1/chat', 'test', 0, 404, NULL),
	        (datetime('now', '-4 hours'),    'POST', '/v1/chat', 'test', 0, NULL, NULL),
	        (datetime('now', '-30 hours'),   'POST', '/v1/chat', 'test', 0, 200, 700),
	        (datetime('now', '-10 days'),    'POST', '/v1/chat', 'test', 0, 200, 500)`); err != nil {
		t.Fatalf("seed logs: %v", err)
	}

	day, err := LogOverview(ctx, database, LogTopWindowOneDay, "", "")
	if err != nil {
		t.Fatalf("1d overview: %v", err)
	}
	if day.TotalRequests != 4 {
		t.Errorf("1d total = %d, want 4", day.TotalRequests)
	}
	// 502 + 404 + missing status are errors; the 200 is not.
	if day.ErrorRequests != 3 {
		t.Errorf("1d errors = %d, want 3", day.ErrorRequests)
	}
	if day.Status2xx != 1 || day.Status4xx != 1 || day.Status5xx != 1 || day.StatusOther != 1 {
		t.Errorf("1d status buckets = %d/%d/%d/%d, want 1/1/1/1",
			day.Status2xx, day.Status4xx, day.Status5xx, day.StatusOther)
	}
	if day.DurationCount != 2 {
		t.Errorf("1d duration count = %d, want 2", day.DurationCount)
	}
	if day.AvgDurationMs != 2000 {
		t.Errorf("1d avg duration = %v, want 2000", day.AvgDurationMs)
	}
	if day.MinDurationMs != 1000 || day.MaxDurationMs != 3000 {
		t.Errorf("1d duration range = %d–%d, want 1000–3000", day.MinDurationMs, day.MaxDurationMs)
	}
	// 24h span / 40 target buckets rounds up to hourly.
	if day.BucketSeconds != 3600 {
		t.Errorf("1d bucket = %ds, want 3600", day.BucketSeconds)
	}
	var latencyRows int64
	for _, bucket := range day.LatencySeries {
		latencyRows += bucket.Count
	}
	// Only rows with a duration enter the latency series.
	if latencyRows != 2 {
		t.Errorf("1d latency series rows = %d, want 2", latencyRows)
	}
	// The request series counts every row, including the ones without durations.
	var requestRows int64
	for _, bucket := range day.RequestSeries {
		requestRows += bucket.Count
	}
	if requestRows != 4 {
		t.Errorf("1d request series rows = %d, want 4", requestRows)
	}
	// The 1d previous period ([-48h, -24h)) holds exactly the -30h row (a 200).
	if day.PreviousTotal == nil || *day.PreviousTotal != 1 {
		t.Errorf("1d previous total = %v, want 1", day.PreviousTotal)
	}
	if day.PreviousStatus == nil || day.PreviousStatus.Status2xx != 1 ||
		day.PreviousStatus.Status4xx != 0 || day.PreviousStatus.Status5xx != 0 ||
		day.PreviousStatus.StatusOther != 0 {
		t.Errorf("1d previous status = %+v, want 1/0/0/0", day.PreviousStatus)
	}
	// The series carries per-bucket error counts: 502 + 404 + missing status.
	var seriesErrors int64
	for _, bucket := range day.RequestSeries {
		seriesErrors += bucket.Errors
	}
	if seriesErrors != 3 {
		t.Errorf("1d series errors = %d, want 3", seriesErrors)
	}

	all, err := LogOverview(ctx, database, LogTopWindowAll, "", "")
	if err != nil {
		t.Fatalf("all overview: %v", err)
	}
	if all.TotalRequests != 6 {
		t.Errorf("all total = %d, want 6", all.TotalRequests)
	}
	// "全部" has no previous period to compare against.
	if all.PreviousTotal != nil {
		t.Errorf("all previous total = %v, want nil", *all.PreviousTotal)
	}

	// Custom window covering the last two days must exclude the -10d row.
	end := time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02 15:04:05")
	start := time.Now().UTC().AddDate(0, 0, -2).Format("2006-01-02 15:04:05")
	custom, err := LogOverview(ctx, database, LogTopWindowCustom, start, end)
	if err != nil {
		t.Fatalf("custom overview: %v", err)
	}
	if custom.TotalRequests != 5 {
		t.Errorf("custom total = %d, want 5", custom.TotalRequests)
	}
	if custom.BucketSeconds <= 0 {
		t.Errorf("custom bucket = %d, want positive", custom.BucketSeconds)
	}
	// The equal-length preceding interval ([-5d, -2d)) holds nothing.
	if custom.PreviousTotal == nil || *custom.PreviousTotal != 0 {
		t.Errorf("custom previous total = %v, want 0", custom.PreviousTotal)
	}
}

// TestLogOverviewSurvivesAnEmptyTable pins the "all" window's span fallback:
// with no logs at all, the series is empty rather than an error, and the
// bucket width falls back to the smallest step.
func TestLogOverviewSurvivesAnEmptyTable(t *testing.T) {
	database := memoryDB(t)

	out, err := LogOverview(context.Background(), database, LogTopWindowAll, "", "")
	if err != nil {
		t.Fatalf("overview on empty table: %v", err)
	}
	if out.TotalRequests != 0 || len(out.LatencySeries) != 0 {
		t.Errorf("empty table produced totals %d / %d series rows",
			out.TotalRequests, len(out.LatencySeries))
	}
	if out.BucketSeconds != latencyBucketSteps[0] {
		t.Errorf("empty-table bucket = %d, want smallest step %d",
			out.BucketSeconds, latencyBucketSteps[0])
	}
}
