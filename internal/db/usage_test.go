package db

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func int32p(value int32) *int32 { return &value }

type hourRow struct{ hour, requests, errors, tokens int64 }

func usageHours(t *testing.T, database *sql.DB) []hourRow {
	t.Helper()
	rows, err := database.Query(
		"SELECT hour_start, requests, errors, total_tokens FROM usage_hourly ORDER BY hour_start")
	if err != nil {
		t.Fatalf("read usage_hourly: %v", err)
	}
	defer rows.Close()

	var out []hourRow
	for rows.Next() {
		var row hourRow
		if err := rows.Scan(&row.hour, &row.requests, &row.errors, &row.tokens); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, row)
	}
	return out
}

func utc(value string) time.Time {
	parsed, err := time.Parse("2006-01-02 15:04", value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func TestUsageTalliesAddUpPerHourAcrossBatches(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	first := UsageTally{}
	first.Add(utc("2026-11-04 10:05"), int32p(200), int32p(100))
	first.Add(utc("2026-11-04 10:59"), int32p(500), nil)
	first.Add(utc("2026-11-04 11:00"), nil, int32p(50))
	if err := AddUsage(ctx, database, first); err != nil {
		t.Fatalf("add first: %v", err)
	}

	second := UsageTally{}
	second.Add(utc("2026-11-04 10:30"), int32p(201), int32p(7))
	if err := AddUsage(ctx, database, second); err != nil {
		t.Fatalf("add second: %v", err)
	}

	ten := utc("2026-11-04 10:00").Unix()
	want := []hourRow{
		{hour: ten, requests: 3, errors: 1, tokens: 107},
		{hour: ten + 3600, requests: 1, errors: 1, tokens: 50},
	}
	got := usageHours(t, database)
	if len(got) != len(want) {
		t.Fatalf("hours = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("hour %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestDailyUsageFoldsHoursIntoTheReadersDays(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// One request in each hour, and the hour's position as its token count.
	tally := UsageTally{}
	for i, at := range []string{
		"2026-11-03 15:00", // 23:00 in +08, 10:00 in -05
		"2026-11-03 16:00", // 00:00 in +08
		"2026-11-04 03:00", // 22:00 in -05
		"2026-11-04 05:00", // 00:00 in -05
	} {
		tally.Add(utc(at), int32p(200), int32p(int32(1)<<i))
	}
	if err := AddUsage(ctx, database, tally); err != nil {
		t.Fatalf("add: %v", err)
	}

	cases := []struct {
		name   string
		since  string
		offset int64
		want   []DailyUsageOut
	}{
		{"east of UTC", "2026-11-01 00:00", 8 * 3600, []DailyUsageOut{
			{Day: "2026-11-03", Requests: 1, TotalTokens: 1},
			{Day: "2026-11-04", Requests: 3, TotalTokens: 2 + 4 + 8},
		}},
		{"west of UTC", "2026-11-01 00:00", -5 * 3600, []DailyUsageOut{
			{Day: "2026-11-03", Requests: 3, TotalTokens: 1 + 2 + 4},
			{Day: "2026-11-04", Requests: 1, TotalTokens: 8},
		}},
		// Midnight of 11-04 in +08 is 16:00 UTC on 11-03.
		{"since the reader's midnight", "2026-11-03 16:00", 8 * 3600, []DailyUsageOut{
			{Day: "2026-11-04", Requests: 3, TotalTokens: 2 + 4 + 8},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DailyUsage(ctx, database, utc(tc.since).Unix(), tc.offset)
			if err != nil {
				t.Fatalf("daily usage: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("days = %+v, want %+v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("day %d = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestDailyUsageOfAnEmptyTableIsAnEmptyList(t *testing.T) {
	days, err := DailyUsage(context.Background(), memoryDB(t), 0, 0)
	if err != nil {
		t.Fatalf("daily usage: %v", err)
	}
	if days == nil || len(days) != 0 {
		t.Errorf("days = %#v, want an empty list", days)
	}
}

// An upgraded database starts with the history its logs still hold, and a
// restart does not count it twice.
func TestUsageHourlyIsFilledOnceFromTheLogsOnDisk(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec("DROP TABLE usage_hourly"); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO request_logs
        (created_at, method, path, status_code, total_tokens) VALUES
        ('2026-11-04 10:05:00', 'POST', '/v1/r', 200, 100),
        ('2026-11-04 10:59:59', 'POST', '/v1/r', 404, NULL),
        ('2026-11-04 11:00:00', 'POST', '/v1/r', NULL, 50),
        ('2026-11-04 11:30:00', 'POST', '/v1/r', 200, 1)`); err != nil {
		t.Fatalf("insert logs: %v", err)
	}

	for range 2 {
		if err := Init(ctx, database); err != nil {
			t.Fatalf("init: %v", err)
		}
	}

	ten := utc("2026-11-04 10:00").Unix()
	want := []hourRow{
		{hour: ten, requests: 2, errors: 1, tokens: 100},
		{hour: ten + 3600, requests: 2, errors: 1, tokens: 51},
	}
	got := usageHours(t, database)
	if len(got) != len(want) {
		t.Fatalf("hours = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("hour %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}
