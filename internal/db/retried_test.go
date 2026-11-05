package db

import (
	"context"
	"database/sql"
	"testing"
)

// One request that failed over: its retried attempt, then the row that ended
// it, plus a request that took a single attempt. Two requests, three rows.
func seedRetriedRequest(t *testing.T) *sql.DB {
	t.Helper()
	database := memoryDB(t)
	if _, err := database.Exec(`INSERT INTO upstreams (name, base_url, model_names)
        VALUES ('first', 'https://a.test', '["m"]'), ('second', 'https://b.test', '["m"]')`); err != nil {
		t.Fatalf("seed channels: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO request_logs
            (created_at, method, path, client_type, stream, upstream_id, upstream_name,
             model, status_code, total_tokens, prompt_tokens, duration_ms, request_id, retried)
        VALUES
            (datetime('now', '-3 minutes'), 'POST', '/v1/chat', 't', 0, 1, 'first', 'm', 400, NULL, NULL, 10, 7, 1),
            (datetime('now', '-2 minutes'), 'POST', '/v1/chat', 't', 0, 2, 'second', 'm', 200, 30, 20, 900, 7, 0),
            (datetime('now', '-1 minutes'), 'POST', '/v1/chat', 't', 0, 2, 'second', 'm', 200, 5, 4, 100, 8, 0)`); err != nil {
		t.Fatalf("seed logs: %v", err)
	}
	return database
}

func TestRetriedAttemptsAreNotRequests(t *testing.T) {
	database := seedRetriedRequest(t)
	ctx := context.Background()

	rebuildStats(t, database)
	overview, err := LogOverview(ctx, database, LogTopWindowOneDay, "", "", 0)
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if overview.TotalRequests != 2 || overview.ErrorRequests != 0 || overview.Status4xx != 0 {
		t.Errorf("overview counted %d requests, %d errors, %d 4xx; want 2, 0, 0",
			overview.TotalRequests, overview.ErrorRequests, overview.Status4xx)
	}
	// The retried attempt's 10 ms is not a request's latency.
	if overview.MinDurationMs != 100 {
		t.Errorf("fastest request %d ms, want 100", overview.MinDurationMs)
	}

	usage, err := QueryTokenUsage(ctx, database, LogTopWindowOneDay, "", "")
	if err != nil {
		t.Fatalf("token usage: %v", err)
	}
	if usage.AllRequestCount != 2 || usage.RequestCount != 2 || usage.TotalTokens != 35 {
		t.Errorf("token usage = %+v, want 2 requests, 2 with usage, 35 tokens", usage)
	}

	top, err := TopLogStats(ctx, database, LogTopWindowOneDay, 5)
	if err != nil {
		t.Fatalf("top: %v", err)
	}
	if len(top.Models) != 1 || top.Models[0].Count != 2 {
		t.Errorf("model ranking = %+v, want m with 2 requests", top.Models)
	}
	// Every attempt reached a channel, so the channel ranking counts it.
	channels := map[string]int64{}
	for _, item := range top.Channels {
		channels[item.Name] = item.Count
	}
	if channels["first"] != 1 || channels["second"] != 2 {
		t.Errorf("channel ranking = %v, want first 1, second 2", channels)
	}
}

func TestRowCountsKeepRetriedAttemptsAndRequestCountsDoNot(t *testing.T) {
	database := seedRetriedRequest(t)
	ctx := context.Background()
	rebuildStats(t, database)

	total, _, err := LogCounts(ctx, database)
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	usage, err := TokenUsageWindows(ctx, database, "")
	if err != nil {
		t.Fatalf("windows: %v", err)
	}
	allTime := usage.AllTime
	if total != 3 || allTime.AllRequestCount != 2 || allTime.TotalTokens != 35 {
		t.Errorf("%d rows, %d requests, %d tokens; want 3, 2, 35",
			total, allTime.AllRequestCount, allTime.TotalTokens)
	}
}

// A retried attempt adds the tokens it spent, never a request or a failure.
func TestARetriedAttemptAddsOnlyItsTokensToTheCalendar(t *testing.T) {
	database := memoryDB(t)
	at := utc("2026-11-04 10:05")

	tally := UsageTally{}
	tally.Add(at, int32p(502), int32p(12), true)
	tally.Add(at, int32p(400), nil, true)
	tally.Add(at, int32p(200), int32p(30), false)
	if err := AddUsage(context.Background(), database, tally); err != nil {
		t.Fatalf("add: %v", err)
	}

	got := usageHours(t, database)
	want := hourRow{hour: utc("2026-11-04 10:00").Unix(), requests: 1, errors: 0, tokens: 42}
	if len(got) != 1 || got[0] != want {
		t.Errorf("hours = %+v, want %+v", got, want)
	}
}
