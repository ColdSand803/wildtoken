package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
)

// stats_hourly holds what the dashboard counts, per UTC hour, channel and
// model. A long range reads a few rows an hour from it instead of every
// request: 180 days of logs took the 30-day overview 1.5 s and the all-time
// rankings 18 s, past the query timeout. Like usage_hourly, retention does not
// thin it.
//
// Its whole hours come from here; the part hours at the edges of a range come
// from request_logs. Both read the rows through statsColumns, so they agree.

// statsColumn is a counter of stats_hourly and what one log row adds to it.
type statsColumn struct {
	name string
	// fact is the row's contribution: 1 or 0 for a condition, or a number.
	fact string
	// fold is the aggregate that combines contributions: SUM, MIN or MAX.
	fold string
}

// countIf is 1 when the condition holds, else 0; NULL operands count as 0.
func countIf(condition string) string {
	return "CASE WHEN " + condition + " THEN 1 ELSE 0 END"
}

// statsColumns: a request is a row that is not a retried attempt; attempts
// are every row, for the channel a request reached.
var statsColumns = []statsColumn{
	{"requests", countIf("retried = 0"), "SUM"},
	{"errors", countIf("retried = 0 AND " + failedRows), "SUM"},
	{"cancelled", countIf("retried = 0 AND " + cancelledRows), "SUM"},
	{"status_2xx", countIf("retried = 0 AND status_code >= 200 AND status_code < 300"), "SUM"},
	{"status_4xx", countIf("retried = 0 AND status_code >= 400 AND status_code < 500 AND status_code <> 499"), "SUM"},
	{"status_5xx", countIf("retried = 0 AND status_code >= 500"), "SUM"},
	{"duration_count", countIf("retried = 0 AND duration_ms >= 0"), "SUM"},
	{"duration_sum", "CASE WHEN retried = 0 AND duration_ms >= 0 THEN duration_ms ELSE 0 END", "SUM"},
	{"duration_min", "CASE WHEN retried = 0 AND duration_ms >= 0 THEN duration_ms END", "MIN"},
	{"duration_max", "CASE WHEN retried = 0 AND duration_ms >= 0 THEN duration_ms END", "MAX"},
	{"token_requests", countIf("retried = 0 AND total_tokens IS NOT NULL"), "SUM"},
	{"attempts", "1", "SUM"},
	{"attempt_errors", countIf(failedRows), "SUM"},
	{"attempt_duration_count", countIf("duration_ms >= 0"), "SUM"},
	{"attempt_duration_sum", "CASE WHEN duration_ms >= 0 THEN duration_ms ELSE 0 END", "SUM"},
	{"total_tokens", "COALESCE(total_tokens, 0)", "SUM"},
	{"prompt_tokens", "COALESCE(prompt_tokens, 0)", "SUM"},
	{"prompt_cached_tokens", "COALESCE(prompt_cached_tokens, 0)", "SUM"},
}

// The keys a log row is filed under. A row without a channel or a model has
// upstream_id 0 or model ”.
const (
	statsHourExpr    = "CAST(strftime('%s', created_at) AS INTEGER) / 3600 * 3600"
	statsChannelExpr = "COALESCE(upstream_id, 0)"
	statsModelExpr   = "COALESCE(" + actualModelExpression + ", '')"
	statsNameExpr    = "COALESCE(TRIM(upstream_name), '')"
)

const createStatsHourly = `
CREATE TABLE stats_hourly (
    hour_start             INTEGER NOT NULL,
    upstream_id            INTEGER NOT NULL,
    model                  TEXT NOT NULL,
    upstream_name          TEXT NOT NULL DEFAULT '',
    requests               INTEGER NOT NULL DEFAULT 0,
    errors                 INTEGER NOT NULL DEFAULT 0,
    cancelled              INTEGER NOT NULL DEFAULT 0,
    status_2xx             INTEGER NOT NULL DEFAULT 0,
    status_4xx             INTEGER NOT NULL DEFAULT 0,
    status_5xx             INTEGER NOT NULL DEFAULT 0,
    duration_count         INTEGER NOT NULL DEFAULT 0,
    duration_sum           INTEGER NOT NULL DEFAULT 0,
    duration_min           INTEGER,
    duration_max           INTEGER,
    token_requests         INTEGER NOT NULL DEFAULT 0,
    attempts               INTEGER NOT NULL DEFAULT 0,
    attempt_errors         INTEGER NOT NULL DEFAULT 0,
    attempt_duration_count INTEGER NOT NULL DEFAULT 0,
    attempt_duration_sum   INTEGER NOT NULL DEFAULT 0,
    total_tokens           INTEGER NOT NULL DEFAULT 0,
    prompt_tokens          INTEGER NOT NULL DEFAULT 0,
    prompt_cached_tokens   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour_start, upstream_id, model)
) WITHOUT ROWID;`

// statsColumnList is "hour_start, upstream_id, model, upstream_name, requests, …".
func statsColumnList() string {
	names := []string{"hour_start", "upstream_id", "model", "upstream_name"}
	for _, column := range statsColumns {
		names = append(names, column.name)
	}
	return strings.Join(names, ", ")
}

// statsRollup is a SELECT that files the request_logs rows matching where
// into stats_hourly rows, in statsColumnList order.
func statsRollup(where string) string {
	var query strings.Builder
	fmt.Fprintf(&query, "SELECT %s, %s, %s, MAX(%s)", statsHourExpr, statsChannelExpr,
		statsModelExpr, statsNameExpr)
	for _, column := range statsColumns {
		fmt.Fprintf(&query, ", %s(%s)", column.fold, column.fact)
	}
	fmt.Fprintf(&query, " FROM request_logs WHERE (%s) AND strftime('%%s', created_at) IS NOT NULL"+
		" GROUP BY 1, 2, 3", where)
	return query.String()
}

// statsUpsert merges a stats_hourly row into the one already there. The name is
// the latest given; the duration bounds take the wider of the two.
func statsUpsert() string {
	var query strings.Builder
	query.WriteString(` ON CONFLICT (hour_start, upstream_id, model) DO UPDATE SET
        upstream_name = CASE WHEN excluded.upstream_name <> '' THEN excluded.upstream_name
                             ELSE upstream_name END`)
	for _, column := range statsColumns {
		switch column.fold {
		case "SUM":
			fmt.Fprintf(&query, ", %[1]s = %[1]s + excluded.%[1]s", column.name)
		default:
			fmt.Fprintf(&query, ", %[1]s = %[2]s(COALESCE(%[1]s, excluded.%[1]s), COALESCE(excluded.%[1]s, %[1]s))",
				column.name, column.fold)
		}
	}
	return query.String()
}

// AddStats folds the request_logs rows with ids in [firstID, lastID] into
// stats_hourly. Run it in the transaction that inserted them: there a batch's
// ids are consecutive, and the totals move only when the rows commit.
func AddStats(ctx context.Context, q Queryer, firstID, lastID int64) error {
	_, err := q.ExecContext(ctx, "INSERT INTO stats_hourly ("+statsColumnList()+") "+
		statsRollup("id BETWEEN ? AND ?")+statsUpsert(), firstID, lastID)
	if err != nil {
		return apperr.Database(err)
	}
	return nil
}

// ensureStatsHourly makes stats_hourly and files the logs on disk into it, in
// one transaction. It does nothing once the table exists: the fill would count
// every row again. Logs pruned before the upgrade stay uncounted.
func ensureStatsHourly(ctx context.Context, database *sql.DB) error {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var exists int64
	if err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'stats_hourly'").
		Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return nil
	}

	for _, statement := range []string{
		createStatsHourly,
		"INSERT INTO stats_hourly (" + statsColumnList() + ") " + statsRollup("1 = 1"),
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("create stats_hourly: %w", err)
		}
	}
	return tx.Commit()
}

// statsSpan is a window in unix seconds, [start, end). start 0 leaves it
// unbounded below, end 0 above.
type statsSpan struct {
	start, end int64
}

const statsTimeLayout = "2006-01-02 15:04:05"

func parseUTCSeconds(value string) (int64, error) {
	parsed, err := time.Parse(statsTimeLayout, value)
	if err != nil {
		return 0, apperr.BadRequest("invalid timestamp " + value)
	}
	return parsed.Unix(), nil
}

// resolveStatsSpan is appendLogTimePredicate's window as a span. Rolling windows
// run back from now: 7 days is 7 × 24 hours, as SQLite's '-7 days' is.
func resolveStatsSpan(window LogTopWindow, startAt, endAt string, now time.Time) (statsSpan, error) {
	day := int64(24 * 3600)
	switch window {
	case LogTopWindowAll:
		return statsSpan{}, nil
	case LogTopWindowCustom:
		if startAt == "" || endAt == "" {
			return statsSpan{}, apperr.BadRequest("custom window requires start_date and end_date")
		}
		start, err := parseUTCSeconds(startAt)
		if err != nil {
			return statsSpan{}, err
		}
		end, err := parseUTCSeconds(endAt)
		if err != nil {
			return statsSpan{}, err
		}
		return statsSpan{start: start, end: end}, nil
	case LogTopWindowToday:
		if startAt != "" {
			start, err := parseUTCSeconds(startAt)
			return statsSpan{start: start}, err
		}
		return statsSpan{start: localDayStartUnixSeconds(now)}, nil
	case LogTopWindowOneDay:
		return statsSpan{start: now.Unix() - day}, nil
	case LogTopWindowThreeDays:
		return statsSpan{start: now.Unix() - 3*day}, nil
	case LogTopWindowSevenDays:
		return statsSpan{start: now.Unix() - 7*day}, nil
	case LogTopWindowThirtyDays:
		return statsSpan{start: now.Unix() - 30*day}, nil
	}
	return statsSpan{}, apperr.BadRequest("invalid log statistics window")
}

// statsFacts is a FROM source covering span, in stats_hourly's columns plus
// at: stats_hourly for its whole hours, request_logs rows for the part hours
// at its edges. at is the hour's start for the one and the row's second for
// the other.
//
// Example: 09:20–14:05 reads stats_hourly for 10:00–14:00 and the logs of
// 09:20–10:00 and 14:00–14:05.
func statsFacts(span statsSpan) (string, []any) {
	from := span.start
	if from%3600 != 0 {
		from = (from/3600 + 1) * 3600
	}
	to := span.end
	if to != 0 {
		to = to / 3600 * 3600
	}

	var parts []string
	var args []any
	raw := func(start, end int64) {
		parts = append(parts, statsRawFacts()+" WHERE created_at >= ? AND created_at < ?")
		args = append(args, time.Unix(start, 0).UTC().Format(statsTimeLayout),
			time.Unix(end, 0).UTC().Format(statsTimeLayout))
	}

	if to != 0 && from >= to {
		// No whole hour inside: all of it from the logs.
		raw(span.start, span.end)
	} else {
		hours := "SELECT hour_start AS at, " + strings.TrimPrefix(statsColumnList(), "hour_start, ") +
			" FROM stats_hourly WHERE hour_start >= ?"
		args = append(args, from)
		if to != 0 {
			hours += " AND hour_start < ?"
			args = append(args, to)
		}
		parts = append(parts, hours)
		if span.start != 0 && span.start < from {
			raw(span.start, from)
		}
		if to != 0 && to < span.end {
			raw(to, span.end)
		}
	}
	return "(" + strings.Join(parts, " UNION ALL ") + ")", args
}

// statsRawFacts selects request_logs rows in stats_hourly's columns, one
// fact per row.
func statsRawFacts() string {
	var query strings.Builder
	fmt.Fprintf(&query, "SELECT CAST(strftime('%%s', created_at) AS INTEGER) AS at, %s AS upstream_id, "+
		"%s AS model, %s AS upstream_name", statsChannelExpr, statsModelExpr, statsNameExpr)
	for _, column := range statsColumns {
		fmt.Fprintf(&query, ", %s AS %s", column.fact, column.name)
	}
	query.WriteString(" FROM request_logs")
	return query.String()
}

// statsTotals sums every counter over a span.
type statsTotals struct {
	requests, errors, cancelled             int64
	status2xx, status4xx, status5xx         int64
	durationCount, durationSum              int64
	durationMin, durationMax                sql.NullInt64
	tokenRequests                           int64
	totalTokens, promptTokens, promptCached int64
}

func queryStatsTotals(ctx context.Context, q Queryer, span statsSpan) (statsTotals, error) {
	source, args := statsFacts(span)
	var totals statsTotals
	err := q.QueryRowContext(ctx, `SELECT
            COALESCE(SUM(requests), 0), COALESCE(SUM(errors), 0), COALESCE(SUM(cancelled), 0),
            COALESCE(SUM(status_2xx), 0), COALESCE(SUM(status_4xx), 0), COALESCE(SUM(status_5xx), 0),
            COALESCE(SUM(duration_count), 0), COALESCE(SUM(duration_sum), 0),
            MIN(duration_min), MAX(duration_max),
            COALESCE(SUM(token_requests), 0),
            COALESCE(SUM(total_tokens), 0), COALESCE(SUM(prompt_tokens), 0),
            COALESCE(SUM(prompt_cached_tokens), 0)
        FROM `+source, args...).Scan(&totals.requests, &totals.errors, &totals.cancelled,
		&totals.status2xx, &totals.status4xx, &totals.status5xx,
		&totals.durationCount, &totals.durationSum, &totals.durationMin, &totals.durationMax,
		&totals.tokenRequests, &totals.totalTokens, &totals.promptTokens, &totals.promptCached)
	if err != nil {
		return totals, apperr.Database(err)
	}
	return totals, nil
}

// ChannelTotalsOut is one channel's traffic since stats_hourly began.
type ChannelTotalsOut struct {
	UpstreamID         int64
	Attempts           int64
	PromptCachedTokens int64
	PromptTokens       int64
	TotalTokens        int64
}

// ChannelTotals sums each channel's traffic: every attempt it took and every
// token it spent. Read from stats_hourly, so retention does not thin it; read
// from the logs it was a scan of every row, 4.2 s at 180 days of traffic.
func ChannelTotals(ctx context.Context, database *sql.DB) ([]ChannelTotalsOut, error) {
	rows, err := database.QueryContext(ctx, `SELECT upstream_id, SUM(attempts),
            SUM(prompt_cached_tokens), SUM(prompt_tokens), SUM(total_tokens)
        FROM stats_hourly WHERE upstream_id <> 0 GROUP BY upstream_id`)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	var totals []ChannelTotalsOut
	for rows.Next() {
		var row ChannelTotalsOut
		if err := rows.Scan(&row.UpstreamID, &row.Attempts, &row.PromptCachedTokens,
			&row.PromptTokens, &row.TotalTokens); err != nil {
			return nil, apperr.Database(err)
		}
		totals = append(totals, row)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return totals, nil
}
