package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/apperr"
)

// UpstreamHealthBucketOut is one hour of a channel's traffic: how many requests
// were attempted, how many failed, and the average latency of timed rows.
type UpstreamHealthBucketOut struct {
	BucketEpoch int64   `json:"bucket_epoch"`
	Total       int64   `json:"total"`
	Errors      int64   `json:"errors"`
	TimedCount  int64   `json:"timed_count"`
	AvgMs       float64 `json:"avg_ms"`
}

// UpstreamHealthOut aggregates one channel's trailing window.
//
// SuccessRate and AvgMs summarise the whole window; Buckets carries the hourly
// series the console draws as a mini trend. SuccessRate uses the same error
// definition as the dashboard: no status code, or anything outside 2xx.
type UpstreamHealthOut struct {
	UpstreamID  int64                     `json:"upstream_id"`
	Total       int64                     `json:"total"`
	Errors      int64                     `json:"errors"`
	SuccessRate float64                   `json:"success_rate"`
	TimedCount  int64                     `json:"timed_count"`
	AvgMs       float64                   `json:"avg_ms"`
	Buckets     []UpstreamHealthBucketOut `json:"buckets"`
}

// UpstreamHealthHistory reports per-channel hourly health over the trailing
// hours, computed straight from request_logs. Computing on read keeps the
// write path free of bookkeeping and stays cheap because the window is short
// and grouped in SQL.
//
// excludeClientTypes drops the console's own probes from the aggregate. They
// share request_logs with proxied traffic so the log page can filter them, but
// counting them here would let an operator move the number this card reports
// just by clicking "test" — and a batch probe across every channel would move it
// a lot. The caller passes the set because it owns those client_type values.
func UpstreamHealthHistory(ctx context.Context, database *sql.DB, hours int64,
	excludeClientTypes []string) (map[int64]*UpstreamHealthOut, error) {
	hours = min(max(hours, 1), 24*7)
	cutoff := fmt.Sprintf("-%d hours", hours)

	var exclusion strings.Builder
	args := []any{cutoff}
	if len(excludeClientTypes) > 0 {
		exclusion.WriteString(" AND client_type NOT IN (")
		for index, clientType := range excludeClientTypes {
			if index > 0 {
				exclusion.WriteString(", ")
			}
			exclusion.WriteString("?")
			args = append(args, clientType)
		}
		exclusion.WriteString(")")
	}

	rows, err := database.QueryContext(ctx, `
		SELECT upstream_id,
			(CAST(strftime('%s', created_at) AS INTEGER) / 3600) * 3600 AS bucket_epoch,
			COUNT(*),
			COALESCE(SUM(CASE WHEN (status_code IS NULL OR status_code < 200 OR status_code >= 300) AND (status_code IS NULL OR status_code <> 499) THEN 1 ELSE 0 END), 0),
			AVG(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms END),
			COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0)
		FROM request_logs
		WHERE upstream_id IS NOT NULL AND created_at >= datetime('now', ?)`+
		exclusion.String()+`
		GROUP BY upstream_id, bucket_epoch
		ORDER BY bucket_epoch ASC`, args...)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	out := map[int64]*UpstreamHealthOut{}
	for rows.Next() {
		var upstreamID, epoch, total, errors, timedCount int64
		var avgMs sql.NullFloat64
		if err := rows.Scan(&upstreamID, &epoch, &total, &errors, &avgMs, &timedCount); err != nil {
			return nil, apperr.Database(err)
		}
		entry, ok := out[upstreamID]
		if !ok {
			entry = &UpstreamHealthOut{UpstreamID: upstreamID, Buckets: []UpstreamHealthBucketOut{}}
			out[upstreamID] = entry
		}
		entry.Total += total
		entry.Errors += errors
		entry.TimedCount += timedCount
		entry.Buckets = append(entry.Buckets, UpstreamHealthBucketOut{
			BucketEpoch: epoch,
			Total:       total,
			Errors:      errors,
			TimedCount:  timedCount,
			AvgMs:       avgMs.Float64,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}

	for _, entry := range out {
		if entry.Total > 0 {
			entry.SuccessRate = float64(entry.Total-entry.Errors) / float64(entry.Total)
		}
		// Buckets only carry averages, so the window average is weighted by each
		// bucket's timed-sample count. Weighting by total requests skewed the
		// result whenever buckets held different numbers of untimed rows, and
		// gating on AvgMs > 0 silently dropped legitimate 0ms samples.
		var weighted, timedRequests float64
		for _, bucket := range entry.Buckets {
			if bucket.TimedCount > 0 {
				weighted += bucket.AvgMs * float64(bucket.TimedCount)
				timedRequests += float64(bucket.TimedCount)
			}
		}
		if timedRequests > 0 {
			entry.AvgMs = weighted / timedRequests
		}
	}
	return out, nil
}
