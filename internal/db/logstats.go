package db

import (
	"context"
	"database/sql"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// slowDBOperationThreshold is how long a statement may run before the runtime
// metrics count it as slow.
const slowDBOperationThreshold = time.Second

// QueryTokenUsage aggregates one window: stats_hourly for its whole hours, the
// logs for the part hours at its edges. Custom bounds are UTC timestamps and
// form a half-open interval [startAt, endAt).
//
// Requests leave out retried attempts; tokens do not, since the attempt spent
// them.
func QueryTokenUsage(ctx context.Context, database *sql.DB, window LogTopWindow,
	startAt, endAt string) (models.TokenUsageWindowOut, error) {
	span, err := resolveStatsSpan(window, startAt, endAt, time.Now())
	if err != nil {
		return models.TokenUsageWindowOut{}, err
	}
	totals, err := queryStatsTotals(ctx, database, span)
	if err != nil {
		return models.TokenUsageWindowOut{}, err
	}
	return models.TokenUsageWindowOut{
		TotalTokens:        totals.totalTokens,
		PromptTokens:       totals.promptTokens,
		PromptCachedTokens: totals.promptCached,
		RequestCount:       totals.tokenRequests,
		AllRequestCount:    totals.requests,
	}, nil
}

// TokenUsageWindows reports the dashboard's five standard windows. todayStart
// is the operator's midnight as a UTC timestamp; empty means the server's.
//
// Each window is a few hundred stats_hourly rows at most, so they are read on
// demand. A cache rebuilt from the logs every minute cost 1.9 s a rebuild at
// 180 days of traffic.
func TokenUsageWindows(ctx context.Context, database *sql.DB,
	todayStart string) (models.TokenUsageStatsOut, error) {
	var out models.TokenUsageStatsOut
	for _, window := range []struct {
		kind LogTopWindow
		into *models.TokenUsageWindowOut
	}{
		{LogTopWindowToday, &out.Today},
		{LogTopWindowOneDay, &out.OneDay},
		{LogTopWindowSevenDays, &out.SevenDays},
		{LogTopWindowThirtyDays, &out.ThirtyDays},
		{LogTopWindowAll, &out.AllTime},
	} {
		usage, err := QueryTokenUsage(ctx, database, window.kind, todayStart, "")
		if err != nil {
			return out, err
		}
		*window.into = usage
	}
	return out, nil
}

// LogCounts reports how many log rows there are, and how many arrived in the
// last 24 hours: rows, attempts included, as the settings page labels them.
func LogCounts(ctx context.Context, database *sql.DB) (total, lastDay int64, err error) {
	err = database.QueryRowContext(ctx, `SELECT
            (SELECT COUNT(*) FROM request_logs),
            (SELECT COUNT(*) FROM request_logs WHERE created_at >= datetime('now', '-1 day'))`).
		Scan(&total, &lastDay)
	if err != nil {
		return 0, 0, apperr.Database(err)
	}
	return total, lastDay, nil
}

// localDayStartUnixSeconds is midnight in the server's local zone, because the
// console's "today" card is read by an operator in that zone.
func localDayStartUnixSeconds(now time.Time) int64 {
	local := now.Local()
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	return dayStart.Unix()
}

// RecentOneMinuteLogCount counts successful (2xx) request logs in the strict
// trailing 60-second window. Only 2xx responses count toward RPM, matching the
// log-page rate display.
func RecentOneMinuteLogCount(ctx context.Context, database *sql.DB) (int64, error) {
	var count int64
	err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM request_logs
           WHERE created_at >= datetime('now', '-60 seconds')
             AND status_code >= 200 AND status_code < 300`).Scan(&count)
	if err != nil {
		return 0, apperr.Database(err)
	}
	return count, nil
}

// RecentLogRate is the successful request and token totals in the strict
// trailing 60-second window.
type RecentLogRate struct {
	RequestCount int64
	TotalTokens  int64
}

func RecentOneMinuteLogRate(ctx context.Context, database *sql.DB) (RecentLogRate, error) {
	var rate RecentLogRate
	err := database.QueryRowContext(ctx, `SELECT
               COUNT(*) AS request_count,
               COALESCE(SUM(total_tokens), 0) AS total_tokens
           FROM request_logs
           WHERE created_at >= datetime('now', '-60 seconds')
             AND status_code >= 200 AND status_code < 300`).
		Scan(&rate.RequestCount, &rate.TotalTokens)
	if err != nil {
		return rate, apperr.Database(err)
	}
	return rate, nil
}
