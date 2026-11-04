package db

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// seedRandomLogs writes n log rows over three days from base, with every kind
// of value stats_hourly has to file: no status, 499, retried attempts, no
// duration, no tokens, a blank or padded model, no channel.
func seedRandomLogs(t *testing.T, database *sql.DB, base time.Time, n int, random *rand.Rand) {
	t.Helper()
	if _, err := database.Exec(`INSERT OR IGNORE INTO upstreams (id, name, base_url, model_names)
        VALUES (1, 'one', 'https://a.test', '[]'), (2, 'two', 'https://b.test', '[]'),
               (3, 'three', 'https://c.test', '[]')`); err != nil {
		t.Fatalf("seed channels: %v", err)
	}
	statuses := []any{200, 200, 200, 201, 400, 404, 429, 499, 500, 502, nil}
	models := []any{"alpha", "beta", " beta ", "", nil}
	for i := 0; i < n; i++ {
		at := base.Add(time.Duration(random.IntN(3*24*3600)) * time.Second).UTC().Format(statsTimeLayout)
		var duration, tokens, prompt, cached any
		if random.IntN(5) > 0 {
			duration = random.IntN(60000)
		}
		if random.IntN(4) > 0 {
			tokens, prompt, cached = random.IntN(9000), random.IntN(5000), random.IntN(3000)
		}
		var upstream any
		if channel := random.IntN(4); channel > 0 {
			upstream = channel
		}
		if _, err := database.Exec(`INSERT INTO request_logs
                (created_at, method, path, client_type, stream, upstream_id, upstream_name,
                 model, upstream_model, status_code, duration_ms, total_tokens, prompt_tokens,
                 prompt_cached_tokens, retried)
            VALUES (?, 'POST', 'messages', 't', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			at, upstream, fmt.Sprintf("channel %v", upstream), models[random.IntN(len(models))],
			models[random.IntN(len(models))], statuses[random.IntN(len(statuses))], duration,
			tokens, prompt, cached, random.IntN(10) == 0); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
}

// rawTotals sums the same facts straight from the logs in span.
func rawTotals(t *testing.T, database *sql.DB, span statsSpan) statsTotals {
	t.Helper()
	where, args := "1 = 1", []any{}
	if span.start != 0 {
		where += " AND created_at >= ?"
		args = append(args, time.Unix(span.start, 0).UTC().Format(statsTimeLayout))
	}
	if span.end != 0 {
		where += " AND created_at < ?"
		args = append(args, time.Unix(span.end, 0).UTC().Format(statsTimeLayout))
	}
	var totals statsTotals
	if err := database.QueryRow(`SELECT
            COALESCE(SUM(requests), 0), COALESCE(SUM(errors), 0), COALESCE(SUM(cancelled), 0),
            COALESCE(SUM(status_2xx), 0), COALESCE(SUM(status_4xx), 0), COALESCE(SUM(status_5xx), 0),
            COALESCE(SUM(duration_count), 0), COALESCE(SUM(duration_sum), 0),
            MIN(duration_min), MAX(duration_max), COALESCE(SUM(token_requests), 0),
            COALESCE(SUM(total_tokens), 0), COALESCE(SUM(prompt_tokens), 0),
            COALESCE(SUM(prompt_cached_tokens), 0)
        FROM (`+statsRawFacts()+` WHERE `+where+`)`, args...).Scan(
		&totals.requests, &totals.errors, &totals.cancelled,
		&totals.status2xx, &totals.status4xx, &totals.status5xx,
		&totals.durationCount, &totals.durationSum, &totals.durationMin, &totals.durationMax,
		&totals.tokenRequests, &totals.totalTokens, &totals.promptTokens, &totals.promptCached); err != nil {
		t.Fatalf("raw totals: %v", err)
	}
	return totals
}

// rebuildStats files the logs on disk into a fresh stats_hourly, as an
// upgrade does.
func rebuildStats(t *testing.T, database *sql.DB) {
	t.Helper()
	if _, err := database.Exec("DROP TABLE IF EXISTS stats_hourly"); err != nil {
		t.Fatal(err)
	}
	if err := ensureStatsHourly(context.Background(), database); err != nil {
		t.Fatalf("rebuild stats: %v", err)
	}
}

func statsRows(t *testing.T, database *sql.DB) []string {
	t.Helper()
	rows, err := database.Query("SELECT * FROM stats_hourly ORDER BY hour_start, upstream_id, model")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, _ := rows.Columns()
	var out []string
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		rows.Scan(pointers...)
		out = append(out, fmt.Sprint(values...))
	}
	return out
}

// Kept up batch by batch, the rollup matches one filed from scratch, and any
// span read through it matches the logs read row by row.
func TestStatsHourlyAgreesWithTheLogs(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	random := rand.New(rand.NewPCG(7, 11))
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	seedRandomLogs(t, database, base, 900, random)

	// Five batches, as the log writer would add them, several sharing hours.
	var maxID int64
	database.QueryRow("SELECT MAX(id) FROM request_logs").Scan(&maxID)
	for first := int64(1); first <= maxID; first += 180 {
		if err := AddStats(ctx, database, first, min(first+179, maxID)); err != nil {
			t.Fatalf("add stats: %v", err)
		}
	}
	incremental := statsRows(t, database)
	rebuildStats(t, database)
	if rebuilt := statsRows(t, database); fmt.Sprint(rebuilt) != fmt.Sprint(incremental) {
		t.Fatalf("batches and a rebuild disagree:\n%v\n%v", incremental, rebuilt)
	}

	spans := []statsSpan{{}, {start: base.Unix() + 1}}
	for range 40 {
		start := base.Unix() + random.Int64N(3*24*3600)
		end := start + random.Int64N(30*3600)
		spans = append(spans, statsSpan{start: start, end: end}, statsSpan{start: start})
	}
	for _, span := range spans {
		got, err := queryStatsTotals(ctx, database, span)
		if err != nil {
			t.Fatalf("totals %+v: %v", span, err)
		}
		if want := rawTotals(t, database, span); got != want {
			t.Fatalf("span %+v:\n got %+v\nwant %+v", span, got, want)
		}
	}
}

// The rankings and the overview's series read through stats_hourly match the
// same figures counted from the logs row by row.
func TestRankingsAndSeriesAgreeWithTheLogs(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	random := rand.New(rand.NewPCG(3, 5))
	base := time.Now().UTC().Add(-50 * time.Hour)
	seedRandomLogs(t, database, base, 1500, random)
	rebuildStats(t, database)

	// Requests per model, attempts per channel, tokens per each: from the logs.
	reference := func(key, metric, filter string) map[string]int64 {
		rows, err := database.Query(`SELECT ` + key + `, SUM(` + metric + `) FROM (` + statsRawFacts() +
			`) WHERE ` + filter + ` GROUP BY 1 HAVING SUM(` + metric + `) > 0`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]int64{}
		for rows.Next() {
			var name string
			var value int64
			rows.Scan(&name, &value)
			out[name] = value
		}
		return out
	}
	ranked := func(items []models.RequestLogTopItemOut) map[string]int64 {
		out := map[string]int64{}
		for _, item := range items {
			out[item.Name] = item.Count
		}
		return out
	}

	top, err := TopLogStats(ctx, database, LogTopWindowAll, 20)
	if err != nil {
		t.Fatalf("top: %v", err)
	}
	channelName := "CASE WHEN upstream_name <> '' THEN upstream_name ELSE '#' || upstream_id END"
	for _, check := range []struct {
		name string
		got  map[string]int64
		want map[string]int64
	}{
		{"models", ranked(top.Models), reference("model", "requests", "model <> ''")},
		{"channels", ranked(top.Channels), reference(channelName, "attempts", "upstream_id <> 0")},
		{"model tokens", ranked(top.ModelTokens), reference("model", "total_tokens", "model <> ''")},
		{"channel tokens", ranked(top.ChannelTokens), reference(channelName, "total_tokens", "upstream_id <> 0")},
	} {
		if fmt.Sprint(check.got) != fmt.Sprint(check.want) {
			t.Errorf("%s: got %v, want %v", check.name, check.got, check.want)
		}
	}

	// Series: 3-day window, 2-hour buckets, in a whole-hour zone and in +05:30.
	for _, offset := range []int64{8 * 3600, -5 * 3600, 5*3600 + 1800} {
		overview, err := LogOverview(ctx, database, LogTopWindowThreeDays, "", "", offset)
		if err != nil {
			t.Fatalf("overview: %v", err)
		}
		rows, err := database.Query(`SELECT ((at + ?) / ?) * ? - ?, SUM(requests), SUM(errors)
            FROM (`+statsRawFacts()+` WHERE created_at >= datetime('now', '-3 days'))
            GROUP BY 1 HAVING SUM(requests) > 0 ORDER BY 1`,
			offset, overview.BucketSeconds, overview.BucketSeconds, offset)
		if err != nil {
			t.Fatal(err)
		}
		var want []RequestBucketOut
		for rows.Next() {
			var bucket RequestBucketOut
			rows.Scan(&bucket.BucketEpoch, &bucket.Count, &bucket.Errors)
			want = append(want, bucket)
		}
		rows.Close()
		if fmt.Sprint(overview.RequestSeries) != fmt.Sprint(want) {
			t.Errorf("offset %d, %ds buckets:\n got %v\nwant %v", offset, overview.BucketSeconds,
				overview.RequestSeries, want)
		}
	}
}
