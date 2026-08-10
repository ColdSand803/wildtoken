package db

import (
	"context"
	"database/sql"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/wildtoken/wildtoken/internal/apperr"
	"github.com/wildtoken/wildtoken/internal/models"
)

const (
	logStatsWindowDays       = 30
	slowDBOperationThreshold = time.Second
	// LogStatsRefreshInterval is how often the cache is rebuilt from SQLite.
	LogStatsRefreshInterval = 60 * time.Second
)

// PersistedLogStats is the counted subset of a row that just committed.
type PersistedLogStats struct {
	ID                   int64
	CreatedAtUnixSeconds int64
	TotalTokens          *int64
	PromptTokens         *int64
	PromptCachedTokens   *int64
}

// LogStatsSnapshot is what the admin console reads.
type LogStatsSnapshot struct {
	TotalLogCount int64
	LogCount24h   int64
	TokenUsage    models.TokenUsageStatsOut
}

type logStatsBucket struct {
	requestCount       int64
	tokenRequestCount  int64
	totalTokens        int64
	promptTokens       int64
	promptCachedTokens int64
}

func (b *logStatsBucket) add(other logStatsBucket) {
	b.requestCount += other.requestCount
	b.tokenRequestCount += other.tokenRequestCount
	b.totalTokens += other.totalTokens
	b.promptTokens += other.promptTokens
	b.promptCachedTokens += other.promptCachedTokens
}

func (b logStatsBucket) window() models.TokenUsageWindowOut {
	return models.TokenUsageWindowOut{
		TotalTokens:        b.totalTokens,
		PromptTokens:       b.promptTokens,
		PromptCachedTokens: b.promptCachedTokens,
		RequestCount:       b.tokenRequestCount,
		AllRequestCount:    b.requestCount,
	}
}

type logStatsState struct {
	totalLogCount     int64
	maxRefreshedLogID int64
	// minuteBuckets is keyed by the bucket's start second.
	minuteBuckets  map[int64]*logStatsBucket
	pendingEntries map[int64]PersistedLogStats
}

func newLogStatsState() logStatsState {
	return logStatsState{
		minuteBuckets:  map[int64]*logStatsBucket{},
		pendingEntries: map[int64]PersistedLogStats{},
	}
}

// LogStatsCache keeps usage totals in memory so the dashboard does not scan the
// log table on every request.
type LogStatsCache struct {
	// refreshMu serializes rebuilds, so two refreshes cannot interleave their
	// reads of SQLite and their merge of pending entries.
	refreshMu sync.Mutex

	mu    sync.Mutex
	state logStatsState
}

func NewLogStatsCache() *LogStatsCache {
	return &LogStatsCache{state: newLogStatsState()}
}

// LoadLogStatsCache builds a cache primed from the database.
func LoadLogStatsCache(ctx context.Context, database *sql.DB) (*LogStatsCache, error) {
	cache := NewLogStatsCache()
	if err := cache.RefreshFromDB(ctx, database); err != nil {
		return nil, err
	}
	return cache, nil
}

// RefreshFromDB rebuilds the cache, keeping entries that committed after the
// watermark this refresh observed.
func (c *LogStatsCache) RefreshFromDB(ctx context.Context, database *sql.DB) error {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()

	var totalLogCount int64
	var maxLogID sql.NullInt64
	err := database.QueryRowContext(ctx,
		"SELECT COUNT(*) AS total_log_count, MAX(id) AS max_log_id FROM request_logs").
		Scan(&totalLogCount, &maxLogID)
	if err != nil {
		return apperr.Database(err)
	}

	rows, err := database.QueryContext(ctx, `SELECT
           CAST((CAST(strftime('%s', created_at) AS INTEGER) / 60) * 60 AS INTEGER)
               AS bucket_start_unix_seconds,
           COUNT(*) AS request_count,
           COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END), 0)
               AS token_request_count,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(prompt_cached_tokens), 0) AS prompt_cached_tokens
       FROM request_logs
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY bucket_start_unix_seconds
       ORDER BY bucket_start_unix_seconds`)
	if err != nil {
		return apperr.Database(err)
	}
	defer rows.Close()

	refreshed := newLogStatsState()
	refreshed.totalLogCount = totalLogCount
	refreshed.maxRefreshedLogID = maxLogID.Int64
	for rows.Next() {
		var bucketStart int64
		bucket := &logStatsBucket{}
		if err := rows.Scan(&bucketStart, &bucket.requestCount, &bucket.tokenRequestCount,
			&bucket.totalTokens, &bucket.promptTokens, &bucket.promptCachedTokens); err != nil {
			return apperr.Database(err)
		}
		refreshed.minuteBuckets[bucketStart] = bucket
	}
	if err := rows.Err(); err != nil {
		return apperr.Database(err)
	}

	now := time.Now().UTC()

	c.mu.Lock()
	defer c.mu.Unlock()

	// Entries that committed after this refresh read the table are not in the
	// rebuilt buckets yet, so carry them over rather than losing the count.
	pending := slices.Collect(maps.Values(c.state.pendingEntries))
	slices.SortFunc(pending, func(left, right PersistedLogStats) int {
		return int(left.ID - right.ID)
	})
	for _, entry := range pending {
		if entry.ID <= refreshed.maxRefreshedLogID {
			continue
		}
		refreshed.applyPersistedEntry(entry, now)
		refreshed.pendingEntries[entry.ID] = entry
	}
	refreshed.prune(now)

	c.state = refreshed
	return nil
}

// RecordPersistedEntries folds committed rows into the cache without a rebuild.
func (c *LogStatsCache) RecordPersistedEntries(entries []PersistedLogStats) {
	if len(entries) == 0 {
		return
	}
	now := time.Now().UTC()

	c.mu.Lock()
	defer c.mu.Unlock()

	c.state.prune(now)
	for _, entry := range entries {
		if entry.ID <= c.state.maxRefreshedLogID {
			continue
		}
		if _, seen := c.state.pendingEntries[entry.ID]; seen {
			continue
		}
		c.state.applyPersistedEntry(entry, now)
		c.state.pendingEntries[entry.ID] = entry
	}
}

func (c *LogStatsCache) Snapshot() LogStatsSnapshot {
	now := time.Now().UTC()

	c.mu.Lock()
	defer c.mu.Unlock()

	c.state.prune(now)
	return c.state.snapshot(now)
}

func (s *logStatsState) applyPersistedEntry(entry PersistedLogStats, now time.Time) {
	s.totalLogCount++
	if entry.CreatedAtUnixSeconds < oldestWindowStart(now) {
		return
	}

	bucketStart := floorToMinute(entry.CreatedAtUnixSeconds)
	bucket, ok := s.minuteBuckets[bucketStart]
	if !ok {
		bucket = &logStatsBucket{}
		s.minuteBuckets[bucketStart] = bucket
	}
	bucket.requestCount++
	if entry.TotalTokens != nil {
		bucket.tokenRequestCount++
		bucket.totalTokens += *entry.TotalTokens
	}
	if entry.PromptTokens != nil {
		bucket.promptTokens += *entry.PromptTokens
	}
	if entry.PromptCachedTokens != nil {
		bucket.promptCachedTokens += *entry.PromptCachedTokens
	}
}

func (s *logStatsState) prune(now time.Time) {
	oldestBucket := floorToMinute(oldestWindowStart(now))
	for bucketStart := range s.minuteBuckets {
		if bucketStart < oldestBucket {
			delete(s.minuteBuckets, bucketStart)
		}
	}
}

func (s *logStatsState) snapshot(now time.Time) LogStatsSnapshot {
	todayCutoff := localDayStartUnixSeconds(now)
	oneDayCutoff := floorToMinute(now.AddDate(0, 0, -1).Unix())
	sevenDaysCutoff := floorToMinute(now.AddDate(0, 0, -7).Unix())
	thirtyDaysCutoff := floorToMinute(oldestWindowStart(now))

	var today, oneDay, sevenDays, thirtyDays logStatsBucket
	for bucketStart, bucket := range s.minuteBuckets {
		if bucketStart >= todayCutoff {
			today.add(*bucket)
		}
		if bucketStart >= oneDayCutoff {
			oneDay.add(*bucket)
		}
		if bucketStart >= sevenDaysCutoff {
			sevenDays.add(*bucket)
		}
		if bucketStart >= thirtyDaysCutoff {
			thirtyDays.add(*bucket)
		}
	}

	return LogStatsSnapshot{
		TotalLogCount: s.totalLogCount,
		LogCount24h:   oneDay.requestCount,
		TokenUsage: models.TokenUsageStatsOut{
			Today:      today.window(),
			OneDay:     oneDay.window(),
			SevenDays:  sevenDays.window(),
			ThirtyDays: thirtyDays.window(),
		},
	}
}

func oldestWindowStart(now time.Time) int64 {
	return now.AddDate(0, 0, -logStatsWindowDays).Unix()
}

func floorToMinute(timestamp int64) int64 {
	remainder := timestamp % 60
	if remainder < 0 {
		remainder += 60
	}
	return timestamp - remainder
}

// localDayStartUnixSeconds is midnight in the server's local zone, because the
// console's "today" card is read by an operator in that zone.
func localDayStartUnixSeconds(now time.Time) int64 {
	local := now.Local()
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	return dayStart.Unix()
}

// RecentOneMinuteLogCount counts successful (2xx) request logs in the strict
// trailing 60-second window.
//
// RPM is kept separate from the minute-bucket cache: minute buckets are precise
// enough for multi-day usage summaries, but cannot represent a rolling
// second-level boundary without over-counting part of the previous minute. Only
// 2xx responses count toward RPM, matching the log-page rate display.
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

// SlowOperationRecorder is the metrics subset the refresh loop reports to.
type SlowOperationRecorder interface {
	RecordSlowDBOperation()
}

// RunLogStatsRefreshLoop rebuilds the cache on an interval until ctx is done.
func RunLogStatsRefreshLoop(ctx context.Context, database *sql.DB, cache *LogStatsCache,
	recorder SlowOperationRecorder) {
	timer := time.NewTimer(LogStatsRefreshInterval)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		timer.Reset(LogStatsRefreshInterval)

		startedAt := time.Now()
		if err := cache.RefreshFromDB(ctx, database); err != nil {
			slog.Error("failed to refresh request log statistics cache", "error", err)
		}
		if time.Since(startedAt) >= slowDBOperationThreshold {
			recorder.RecordSlowDBOperation()
		}
	}
}
