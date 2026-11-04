//go:build scale

package db

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"
)

// TestScaleDashboardQueries times the dashboard's queries on 180 days of
// traffic, 14,000 requests a day. It builds the database once at SCALE_DB and
// reuses it.
//
//	SCALE_DB=/tmp/scale.db go test -tags scale ./internal/db -run Scale -v
//
// SCALE_MODE=narrow files a few channels and models an hour, closer to live
// traffic (3 combinations an hour there); the default has every hour see all
// 50 channels and 12 models, the worst case for stats_hourly.
func TestScaleDashboardQueries(t *testing.T) {
	path := os.Getenv("SCALE_DB")
	fresh := false
	if _, err := os.Stat(path); err != nil {
		fresh = true
	}
	database, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx := context.Background()
	initStart := time.Now()
	if err := Init(ctx, database); err != nil {
		t.Fatal(err)
	}
	t.Logf("init (backfills stats_hourly once) %v", time.Since(initStart).Round(time.Millisecond))
	if fresh {
		// SCALE_MODE=narrow: a few channels and models an hour, as live traffic
		// has; otherwise every hour sees all 50 channels and 12 models.
		channel, model := "(i % 50) + 1", "'model-' || (i % 12)"
		if os.Getenv("SCALE_MODE") == "narrow" {
			channel = "((i / 20000) % 10) * 5 + (i % 5) + 1"
			model = "'model-' || (((i / 30000) % 4) * 3 + (i % 3))"
		}
		if _, err := database.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
            INSERT OR IGNORE INTO upstreams (id, name, base_url, model_names)
            SELECT i, 'channel-' || i, 'https://c' || i || '.test', '[]' FROM n`); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		_, err := database.Exec(`
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2519999)
INSERT INTO request_logs (created_at, method, path, client_type, stream, upstream_id, upstream_name,
    model, request_model, upstream_model, status_code, duration_ms, first_token_ms,
    prompt_tokens, completion_tokens, total_tokens, prompt_cached_tokens, retried, request_id)
SELECT datetime('now', '-' || (i * 6171 / 1000) || ' seconds'), 'POST', 'messages', 'claude', 1,
       ` + channel + `, 'channel', ` + model + `, ` + model + `, ` + model + `,
       CASE WHEN i % 97 = 0 THEN 502 WHEN i % 61 = 0 THEN 499 WHEN i % 89 = 0 THEN 429 ELSE 200 END,
       1000 + (i * 7919) % 60000, 500 + (i * 104729) % 20000,
       (i * 31) % 200000, (i * 17) % 4000, (i * 31) % 200000 + (i * 17) % 4000, (i * 13) % 150000,
       CASE WHEN i % 113 = 0 THEN 1 ELSE 0 END, i
FROM n`)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("seeded in %v", time.Since(start))
	}
	var rows, filed int64
	database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&rows)
	database.QueryRow("SELECT COUNT(*) FROM stats_hourly").Scan(&filed)
	t.Logf("rows: %d", rows)
	if rows > 0 && filed == 0 {
		// Seeded by hand after Init: file the rows as an upgrade would.
		start := time.Now()
		if _, err := database.Exec("DROP TABLE stats_hourly"); err != nil {
			t.Fatal(err)
		}
		if err := ensureStatsHourly(ctx, database); err != nil {
			t.Fatal(err)
		}
		t.Logf("stats_hourly filed from the logs in %v", time.Since(start).Round(time.Millisecond))
	}

	measure := func(name string, run func() error) {
		start := time.Now()
		if err := run(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		t.Logf("%-28s %v", name, time.Since(start).Round(time.Millisecond))
	}
	for _, item := range []struct {
		name   string
		window LogTopWindow
	}{{"all", LogTopWindowAll}, {"30d", LogTopWindowThirtyDays}, {"7d", LogTopWindowSevenDays}, {"1d", LogTopWindowOneDay}} {
		w := item.window
		measure("overview "+item.name, func() error { _, err := LogOverview(ctx, database, w, "", "", 28800); return err })
		measure("top "+item.name, func() error { _, err := TopLogStats(ctx, database, w, 5); return err })
		measure("token usage "+item.name, func() error { _, err := QueryTokenUsage(ctx, database, w, "", ""); return err })
	}
	measure("channel health 7d", func() error { _, err := UpstreamHealthHistory(ctx, database, 168, 28800); return err })
	measure("channel health 24h", func() error { _, err := UpstreamHealthHistory(ctx, database, 24, 28800); return err })
	measure("token usage windows", func() error { _, err := TokenUsageWindows(ctx, database, ""); return err })
	measure("log counts", func() error { _, _, err := LogCounts(ctx, database); return err })
	measure("channel totals", func() error { _, err := ChannelTotals(ctx, database); return err })
	var statsRows int64
	database.QueryRow("SELECT COUNT(*) FROM stats_hourly").Scan(&statsRows)
	t.Logf("stats_hourly rows: %d", statsRows)
	measure("daily usage", func() error {
		_, err := DailyUsage(ctx, database, time.Now().AddDate(0, 0, -371).Unix(), 28800)
		return err
	})
}
