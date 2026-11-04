package db

import (
	"context"
	"testing"
)

// A client that hangs up is not a failed request: 499 counts apart, in the
// overview and in the calendar.
func TestAClientHangingUpIsNotAFailure(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	if _, err := database.Exec(`INSERT INTO request_logs
            (created_at, method, path, client_type, stream, status_code)
        VALUES
            (datetime('now', '-5 minutes'), 'POST', '/v1/chat', 't', 0, 200),
            (datetime('now', '-4 minutes'), 'POST', '/v1/chat', 't', 0, 499),
            (datetime('now', '-3 minutes'), 'POST', '/v1/chat', 't', 0, 404),
            (datetime('now', '-2 minutes'), 'POST', '/v1/chat', 't', 0, NULL)`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rebuildStats(t, database)
	overview, err := LogOverview(ctx, database, LogTopWindowOneDay, "", "", 0)
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	got := []int64{overview.TotalRequests, overview.ErrorRequests, overview.Status2xx,
		overview.Status4xx, overview.StatusCancelled, overview.StatusOther}
	want := []int64{4, 2, 1, 1, 1, 1}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("total/errors/2xx/4xx/cancelled/other = %v, want %v", got, want)
		}
	}

	tally := UsageTally{}
	at := utc("2026-11-04 10:05")
	for _, status := range []*int32{int32p(200), int32p(499), int32p(404), nil} {
		tally.Add(at, status, nil, false)
	}
	if err := AddUsage(ctx, database, tally); err != nil {
		t.Fatalf("add usage: %v", err)
	}
	var requests, errors, cancelled int64
	if err := database.QueryRow(`SELECT requests, errors, cancelled FROM usage_hourly`).
		Scan(&requests, &errors, &cancelled); err != nil {
		t.Fatal(err)
	}
	if requests != 4 || errors != 2 || cancelled != 1 {
		t.Errorf("hour = %d requests, %d errors, %d cancelled; want 4, 2, 1", requests, errors, cancelled)
	}

	days, err := DailyUsage(ctx, database, at.Unix()-3600, 0)
	if err != nil || len(days) != 1 || days[0].Cancelled != 1 || days[0].Errors != 2 {
		t.Errorf("daily = %+v, %v; want 2 errors and 1 cancelled", days, err)
	}
}

// An older calendar counted 499s as errors. Upgrading moves the ones its logs
// still show to the new column, once.
func TestUpgradingMovesCountedCancellationsOutOfTheErrors(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	ten := utc("2026-11-04 10:00").Unix()

	if _, err := database.Exec(`DROP TABLE usage_hourly`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE usage_hourly (
            hour_start INTEGER PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0)`); err != nil {
		t.Fatal(err)
	}
	// Hour ten: three requests, two 499s and a 502, all three counted as errors.
	// Hour eleven has no logs left, so it keeps what it had.
	if _, err := database.Exec(`INSERT INTO usage_hourly VALUES (?, 3, 3, 0), (?, 5, 2, 0)`,
		ten, ten+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO request_logs
            (created_at, method, path, client_type, stream, status_code, retried)
        VALUES ('2026-11-04 10:01:00', 'POST', '/v1/r', 't', 0, 499, 0),
               ('2026-11-04 10:02:00', 'POST', '/v1/r', 't', 0, 499, 0),
               ('2026-11-04 10:03:00', 'POST', '/v1/r', 't', 0, 502, 0),
               ('2026-11-04 10:04:00', 'POST', '/v1/r', 't', 0, 499, 1)`); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if err := Init(ctx, database); err != nil {
			t.Fatalf("init: %v", err)
		}
	}

	rows, err := database.Query(`SELECT hour_start, errors, cancelled FROM usage_hourly ORDER BY hour_start`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got [][3]int64
	for rows.Next() {
		var row [3]int64
		rows.Scan(&row[0], &row[1], &row[2])
		got = append(got, row)
	}
	want := [][3]int64{{ten, 1, 2}, {ten + 3600, 2, 0}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("hours (start, errors, cancelled) = %v, want %v", got, want)
	}
}
