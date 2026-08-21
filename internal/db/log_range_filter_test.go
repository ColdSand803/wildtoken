package db

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func boolPtr(value bool) *bool { return &value }

// rangeFilterRows is the fixture behind the range, stream, and duration filter
// tests. created_at is written explicitly rather than through datetime('now') so
// the boundary cases sit at known instants, and the durations cover the case a
// threshold filter has to decide: a row that was never timed at all.
var rangeFilterRows = []models.RequestLogOut{
	{ID: 1, CreatedAt: "2026-08-17 23:59:59", Stream: 0, DurationMs: int32Ptr(50)},
	{ID: 2, CreatedAt: "2026-08-18 00:00:00", Stream: 1, DurationMs: int32Ptr(0)},
	{ID: 3, CreatedAt: "2026-08-18 06:30:00", Stream: 1, DurationMs: int32Ptr(3000)},
	{ID: 4, CreatedAt: "2026-08-18 12:00:00", Stream: 0, DurationMs: nil},
	{ID: 5, CreatedAt: "2026-08-18 23:59:59", Stream: 1, DurationMs: int32Ptr(10500)},
	{ID: 6, CreatedAt: "2026-08-19 00:00:00", Stream: 0, DurationMs: int32Ptr(120)},
}

func seedRangeFilterRows(t *testing.T, database *sql.DB) {
	t.Helper()
	for _, row := range rangeFilterRows {
		_, err := database.Exec(`INSERT INTO request_logs
            (id, created_at, method, path, client_type, stream, status_code, duration_ms)
            VALUES (?, ?, 'POST', '/v1/chat', 'codex', ?, 200, ?)`,
			row.ID, row.CreatedAt, row.Stream, row.DurationMs)
		if err != nil {
			t.Fatalf("insert log %d: %v", row.ID, err)
		}
	}
}

// TestListLogsFiltersByCreatedAtRange pins the [start, end) boundary. The window
// a drill-down carries is half-open, so the row sitting exactly on start belongs
// to the page and the one sitting exactly on end belongs to the next window --
// otherwise adjacent buckets double-count or drop a request between them.
func TestListLogsFiltersByCreatedAtRange(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	seedRangeFilterRows(t, database)

	testCases := []struct {
		name    string
		start   string
		end     string
		wantIDs []int64
	}{
		{
			name:  "start inclusive, end exclusive",
			start: "2026-08-18 00:00:00", end: "2026-08-19 00:00:00",
			wantIDs: []int64{2, 3, 4, 5},
		},
		{
			name:  "single second window",
			start: "2026-08-18 06:30:00", end: "2026-08-18 06:30:01",
			wantIDs: []int64{3},
		},
		{
			name:  "window covering nothing",
			start: "2026-08-18 13:00:00", end: "2026-08-18 14:00:00",
			wantIDs: []int64{},
		},
		{
			name:  "window spanning every row",
			start: "2026-08-17 00:00:00", end: "2026-08-20 00:00:00",
			wantIDs: []int64{1, 2, 3, 4, 5, 6},
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			items, err := ListLogs(ctx, database, 100, 0, nil, LogFilter{
				Start: stringPtr(testCase.start), End: stringPtr(testCase.end),
			})
			if err != nil {
				t.Fatalf("list logs: %v", err)
			}
			if !sameInts(logIDs(items), testCase.wantIDs) {
				t.Errorf("range [%s, %s) matched %v, want %v",
					testCase.start, testCase.end, logIDs(items), testCase.wantIDs)
			}
		})
	}
}

// TestListLogsRangePagesWithoutLeaking walks a bounded window one page at a time
// through the keyset cursor. Paging is where a range filter tends to leak: the
// cursor moves the created_at bound on every page, so if the window's own bounds
// were dropped along the way the later pages quietly widen past it.
func TestListLogsRangePagesWithoutLeaking(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	seedRangeFilterRows(t, database)

	filter := LogFilter{
		Start: stringPtr("2026-08-18 00:00:00"),
		End:   stringPtr("2026-08-19 00:00:00"),
	}

	var (
		collected []int64
		cursor    *LogCursor
	)
	for range 10 {
		page, err := ListLogs(ctx, database, 2, 0, cursor, filter)
		if err != nil {
			t.Fatalf("list logs: %v", err)
		}
		if len(page) == 0 {
			break
		}
		collected = append(collected, logIDs(page)...)
		last := page[len(page)-1]
		cursor = &LogCursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	// Rows 1 and 6 sit one second outside either edge; neither may appear.
	if want := []int64{2, 3, 4, 5}; !sameInts(collected, want) {
		t.Errorf("paged through %v, want %v", collected, want)
	}
}

// TestListLogsFiltersByStreamAndDuration covers the two P0-B3 filters, including
// the row with no recorded duration: an untimed request cannot be shown to have
// crossed a latency threshold, so it must not appear under one.
func TestListLogsFiltersByStreamAndDuration(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	seedRangeFilterRows(t, database)

	testCases := []struct {
		name    string
		filter  LogFilter
		wantIDs []int64
	}{
		{name: "streaming only", filter: LogFilter{Stream: boolPtr(true)},
			wantIDs: []int64{2, 3, 5}},
		{name: "non-streaming only", filter: LogFilter{Stream: boolPtr(false)},
			wantIDs: []int64{1, 4, 6}},
		{
			// Zero is a legitimate sample, so a >=0 threshold keeps it while
			// still excluding the untimed row.
			name: "threshold zero keeps timed rows only",
			filter:  LogFilter{MinDurationMs: int64Ptr(0)},
			wantIDs: []int64{1, 2, 3, 5, 6},
		},
		{name: "slower than 3s", filter: LogFilter{MinDurationMs: int64Ptr(3000)},
			wantIDs: []int64{3, 5}},
		{name: "slower than 10s", filter: LogFilter{MinDurationMs: int64Ptr(10000)},
			wantIDs: []int64{5}},
		{
			name: "streaming and slow within a window",
			filter: LogFilter{
				Stream:        boolPtr(true),
				MinDurationMs: int64Ptr(3000),
				Start:         stringPtr("2026-08-18 00:00:00"),
				End:           stringPtr("2026-08-18 12:00:00"),
			},
			wantIDs: []int64{3},
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			items, err := ListLogs(ctx, database, 100, 0, nil, testCase.filter)
			if err != nil {
				t.Fatalf("list logs: %v", err)
			}
			if !sameInts(logIDs(items), testCase.wantIDs) {
				t.Errorf("matched %v, want %v", logIDs(items), testCase.wantIDs)
			}
		})
	}
}

// TestRangeFiltersMatchesAgreesWithSQL extends the live-stream/SQL equivalence
// check to the new filters. Every filter the listing understands needs a Go twin,
// or a filtered console shows one set of rows in its history and another as
// events arrive.
func TestRangeFiltersMatchesAgreesWithSQL(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	seedRangeFilterRows(t, database)

	filters := []struct {
		name   string
		filter LogFilter
	}{
		{name: "no filter", filter: LogFilter{}},
		{name: "range", filter: LogFilter{
			Start: stringPtr("2026-08-18 00:00:00"), End: stringPtr("2026-08-19 00:00:00")}},
		{name: "range boundary single second", filter: LogFilter{
			Start: stringPtr("2026-08-18 06:30:00"), End: stringPtr("2026-08-18 06:30:01")}},
		{name: "streaming", filter: LogFilter{Stream: boolPtr(true)}},
		{name: "non streaming", filter: LogFilter{Stream: boolPtr(false)}},
		{name: "threshold zero", filter: LogFilter{MinDurationMs: int64Ptr(0)}},
		{name: "threshold 3s", filter: LogFilter{MinDurationMs: int64Ptr(3000)}},
		{name: "range and stream and threshold", filter: LogFilter{
			Start:         stringPtr("2026-08-18 00:00:00"),
			End:           stringPtr("2026-08-19 00:00:00"),
			Stream:        boolPtr(true),
			MinDurationMs: int64Ptr(1000),
		}},
	}

	for _, testCase := range filters {
		t.Run(testCase.name, func(t *testing.T) {
			listed, err := ListLogs(ctx, database, 100, 0, nil, testCase.filter)
			if err != nil {
				t.Fatalf("list logs: %v", err)
			}
			wantIDs := logIDs(listed)

			gotIDs := []int64{}
			for _, row := range rangeFilterRows {
				if testCase.filter.Matches(row) {
					gotIDs = append(gotIDs, row.ID)
				}
			}

			if !sameInts(gotIDs, wantIDs) {
				t.Errorf("live matcher selected %v, SQL selected %v", gotIDs, wantIDs)
			}
		})
	}
}

// TestResolveWindowRange checks that presets become concrete instants a
// drill-down can carry, and that the exclusive end still admits the row written
// in the current second.
func TestResolveWindowRange(t *testing.T) {
	now := time.Date(2026, 8, 18, 15, 30, 45, 500_000_000, time.UTC)

	t.Run("relative window", func(t *testing.T) {
		start, end, ok := ResolveWindowRange(LogTopWindowOneDay, now)
		if !ok {
			t.Fatal("1d window did not resolve")
		}
		if want := "2026-08-17 15:30:45"; start.Format(models.TimestampFormat) != want {
			t.Errorf("start = %s, want %s", start.Format(models.TimestampFormat), want)
		}
		// Rounded up, so a row created during the current second is inside the
		// half-open range rather than one second short of it.
		if want := "2026-08-18 15:30:46"; end.Format(models.TimestampFormat) != want {
			t.Errorf("end = %s, want %s", end.Format(models.TimestampFormat), want)
		}
	})

	t.Run("today starts at local midnight", func(t *testing.T) {
		start, _, ok := ResolveWindowRange(LogTopWindowToday, now)
		if !ok {
			t.Fatal("today window did not resolve")
		}
		local := now.Local()
		wantLocal := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
		if !start.Equal(wantLocal) {
			t.Errorf("start = %s, want local midnight %s", start, wantLocal)
		}
	})

	t.Run("unbounded windows do not resolve", func(t *testing.T) {
		for _, window := range []LogTopWindow{LogTopWindowAll, LogTopWindowCustom} {
			if _, _, ok := ResolveWindowRange(window, now); ok {
				t.Errorf("window %v resolved to a range, want none", window)
			}
		}
	})
}
