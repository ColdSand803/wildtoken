package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
)

// UsageTally sums a batch's log rows by UTC hour, for AddUsage.
type UsageTally map[int64]*usageHour

type usageHour struct {
	requests  int64
	errors    int64
	cancelled int64
	tokens    int64
}

// Add counts one log row written at createdAt. Failure is the overview's
// test (failedStatus); a 499 counts as cancelled instead. A retried attempt
// adds its tokens but not a request: the row that ends the request counts
// that.
func (t UsageTally) Add(createdAt time.Time, status, totalTokens *int32, retried bool) {
	if retried && (totalTokens == nil || *totalTokens == 0) {
		return
	}

	hour := createdAt.Unix() / 3600 * 3600
	sum := t[hour]
	if sum == nil {
		sum = &usageHour{}
		t[hour] = sum
	}

	if !retried {
		sum.requests++
		switch {
		case status != nil && *status == 499:
			sum.cancelled++
		case failedStatus(status):
			sum.errors++
		}
	}
	if totalTokens != nil {
		sum.tokens += int64(*totalTokens)
	}
}

// AddUsage folds a tally into usage_hourly. Run it in the transaction that
// inserts the rows, so the totals move only when the rows commit.
func AddUsage(ctx context.Context, q Queryer, tally UsageTally) error {
	for hour, sum := range tally {
		if _, err := q.ExecContext(ctx, `INSERT INTO usage_hourly
            (hour_start, requests, errors, cancelled, total_tokens) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(hour_start) DO UPDATE SET
            requests = requests + excluded.requests,
            errors = errors + excluded.errors,
            cancelled = cancelled + excluded.cancelled,
            total_tokens = total_tokens + excluded.total_tokens`,
			hour, sum.requests, sum.errors, sum.cancelled, sum.tokens); err != nil {
			return apperr.Database(err)
		}
	}
	return nil
}

// DailyUsageOut is one day of usage in the reader's zone.
type DailyUsageOut struct {
	Day         string `json:"day"`
	Requests    int64  `json:"requests"`
	Errors      int64  `json:"errors"`
	Cancelled   int64  `json:"cancelled"`
	TotalTokens int64  `json:"total_tokens"`
}

// DailyUsage folds the hours from since onwards into days of a zone offset
// seconds east of UTC, oldest first. Days without requests are left out.
//
// An hour goes to the day its start falls on, which is exact for whole-hour
// zones. In a half-hour zone such as +05:30 the hour that straddles midnight
// lands on the earlier day.
func DailyUsage(ctx context.Context, q Queryer, since, offset int64) ([]DailyUsageOut, error) {
	rows, err := q.QueryContext(ctx, `SELECT (hour_start + ?) / 86400 AS day,
           SUM(requests), SUM(errors), SUM(cancelled), SUM(total_tokens)
    FROM usage_hourly WHERE hour_start >= ?
    GROUP BY day ORDER BY day`, offset, since)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	days := []DailyUsageOut{}
	for rows.Next() {
		var day int64
		var out DailyUsageOut
		if err := rows.Scan(&day, &out.Requests, &out.Errors, &out.Cancelled, &out.TotalTokens); err != nil {
			return nil, apperr.Database(err)
		}
		// Day 20396 is 2025-11-04.
		out.Day = time.Unix(day*86400, 0).UTC().Format("2006-01-02")
		days = append(days, out)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return days, nil
}

// splitCancelled gives an older usage_hourly its cancelled column, and moves
// the 499s it had counted as errors there. Adding the column is what marks the
// move done, so it runs once. Hours whose logs retention already removed keep
// the errors they had: there is nothing left to recount them from.
func splitCancelled(ctx context.Context, database *sql.DB) error {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var exists int64
	if err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM pragma_table_info('usage_hourly') WHERE name = 'cancelled'").
		Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return nil
	}

	for _, statement := range []string{
		"ALTER TABLE usage_hourly ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0",
		`UPDATE usage_hourly SET cancelled = c.n, errors = MAX(errors - c.n, 0)
        FROM (SELECT CAST(strftime('%s', created_at) AS INTEGER) / 3600 * 3600 AS hour,
                     COUNT(*) AS n
              FROM request_logs WHERE retried = 0 AND ` + cancelledRows + `
              GROUP BY hour) AS c
        WHERE usage_hourly.hour_start = c.hour`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("split cancelled from usage_hourly: %w", err)
		}
	}
	return tx.Commit()
}

// ensureUsageHourly makes usage_hourly and fills it from the logs on disk, in
// one transaction so a failed fill leaves no half-counted table behind. It
// does nothing once the table exists: the fill would count every row again.
// Logs pruned before the upgrade are gone and stay uncounted.
func ensureUsageHourly(ctx context.Context, database *sql.DB) error {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var exists int64
	if err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'usage_hourly'").
		Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return nil
	}

	for _, statement := range []string{createUsageHourly, backfillUsageHourly} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("create usage_hourly: %w", err)
		}
	}
	return tx.Commit()
}
