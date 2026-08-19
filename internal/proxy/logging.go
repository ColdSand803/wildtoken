package proxy

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/quota"
)

const (
	slowDBOperationThreshold    = time.Second
	logWriteMaxAttempts         = 5
	logWriteRetryBaseDelay      = 50 * time.Millisecond
	logWriteBatchSize           = 20
	logWriteBatchInterval       = 50 * time.Millisecond
	logWriteTimeout             = 15 * time.Second
	logEventChannelCapacity     = 1024
	cleanupStartupDelay         = 120 * time.Second
	logBodyCleanupInterval      = 60 * time.Second
	logRetentionCleanupInterval = 3600 * time.Second
	incrementalVacuumMaxPages   = 4096
)

// LogEntry is a structured record of one proxied request.
type LogEntry struct {
	Method                    string
	Path                      string
	DownstreamTokenID         *int64
	DownstreamTokenName       *string
	ClientType                *string
	UpstreamID                *int64
	UpstreamName              *string
	Model                     *string
	RequestModel              *string
	UpstreamModel             *string
	ReasoningEffort           *string
	ResponseReasoningEffort   *string
	Stream                    bool
	StatusCode                *int32
	PromptTokens              *int32
	CompletionTokens          *int32
	TotalTokens               *int32
	PromptCachedTokens        *int32
	CacheCreationTokens       *int32
	CompletionReasoningTokens *int32
	FirstTokenMs              *int32
	DurationMs                *int32
	// RequestUID, AttemptIndex, PreUpstreamMs and UpstreamHeadersMs carry the
	// waterfall's raw sample points. See models.RequestLogOut for each field's
	// interval; the shapes here are the same.
	RequestUID        *string
	AttemptIndex      *int32
	PreUpstreamMs     *int32
	UpstreamHeadersMs *int32
	Error             *string
	DownstreamRequest json.RawMessage
	UpstreamRequest           json.RawMessage
	UpstreamResponse          json.RawMessage
	DownstreamResponse        json.RawMessage
}

// LogStreamEvent reports that a committed request-log row became available to
// the admin console.
//
// The database remains the source of truth for pagination and details. The
// event only carries the lightweight list row, without request/response bodies.
type LogStreamEvent struct {
	Log       models.RequestLogOut `json:"log"`
	RecentRPM *int64               `json:"recent_rpm,omitempty"`
	RecentTPM *int64               `json:"recent_tpm,omitempty"`
}

// LogMetricsRecorder is the metrics subset the writer reports to.
type LogMetricsRecorder interface {
	RecordLogEnqueue()
	RecordLogDequeue(count uint64)
	RecordLogWritten(count uint64)
	RecordLogDrop()
	RecordLogWriteFailureCount(count uint64)
	RecordSlowDBOperation()
	BeginCleanup()
	RecordCleanupBatch(rowsCleared uint64)
	FinishCleanup(success bool, duration time.Duration)
}

type persistedLogRecord struct {
	stats db.PersistedLogStats
	event LogStreamEvent
}

// LogWriter batches request logs onto a single background writer, so proxy
// requests never wait on SQLite's write lock.
type LogWriter struct {
	entries chan LogEntry
	metrics LogMetricsRecorder
	events  *eventBroker
	quotas  *quota.Tracker
	done    chan struct{}
	// closeMu orders closing the queue against scheduling onto it. Sending on a
	// closed channel panics and a select's default case does not prevent that,
	// so the two are made exclusive rather than left to race: a stream still
	// running when the server stopped waiting for it schedules its log after
	// shutdown has begun.
	closeMu   sync.RWMutex
	closed    bool
	closeOnce sync.Once
}

// NewLogWriter starts the background writer. It stops when Close is called,
// which is also what drains the queue: ctx bounds each write rather than
// abandoning the rows still waiting to be made.
func NewLogWriter(ctx context.Context, database *sql.DB, metrics LogMetricsRecorder,
	logStats *db.LogStatsCache, queueCapacity int, quotas *quota.Tracker) *LogWriter {
	writer := &LogWriter{
		entries: make(chan LogEntry, max(queueCapacity, 1)),
		metrics: metrics,
		events:  newEventBroker(),
		quotas:  quotas,
		done:    make(chan struct{}),
	}
	go writer.run(ctx, database, logStats)
	return writer
}

// Schedule queues a log entry, dropping it when the queue is full or closed.
//
// A dropped log is preferable to blocking a proxied request on the writer.
func (w *LogWriter) Schedule(entry LogEntry) {
	w.metrics.RecordLogEnqueue()

	// Held across the send so the queue cannot close underneath it.
	w.closeMu.RLock()
	defer w.closeMu.RUnlock()

	if w.closed {
		w.metrics.RecordLogDequeue(1)
		w.metrics.RecordLogDrop()
		slog.Warn("request log queue closed; dropping request log")
		return
	}

	select {
	case w.entries <- entry:
		// The usage is held against the token's quota until the row commits,
		// because until then the stored total still understates it. A dropped
		// entry holds nothing: it will never reach the total either.
		if tokenID, used, ok := quotaUsage(entry); ok {
			w.quotas.Meter(tokenID, used)
		}
	default:
		w.metrics.RecordLogDequeue(1)
		w.metrics.RecordLogDrop()
		slog.Warn("request log queue full; dropping request log")
	}
}

// quotaUsage reports the token and amount a log entry contributes to a quota.
//
// It is the single definition of what counts, so the hold taken at enqueue and
// the increment applied at commit can never disagree.
func quotaUsage(entry LogEntry) (tokenID int64, used int64, ok bool) {
	if entry.DownstreamTokenID == nil || entry.TotalTokens == nil || *entry.TotalTokens <= 0 {
		return 0, 0, false
	}
	return *entry.DownstreamTokenID, int64(*entry.TotalTokens), true
}

// Subscribe returns a channel of committed rows and the function that releases
// it.
func (w *LogWriter) Subscribe() (<-chan LogStreamEvent, func()) {
	return w.events.subscribe()
}

// Close stops accepting entries and waits for the queued batch to drain.
func (w *LogWriter) Close() { w.CloseWithin(0) }

// CloseWithin stops accepting entries and waits up to limit for the queue to
// drain, reporting whether it finished. A limit of zero waits indefinitely.
//
// Shutdown needs the bound. Each batch may spend up to logWriteTimeout on a
// database that has stopped answering, and a full queue is enough batches for
// that to add up to minutes — long past the point where an operator expects the
// process to be gone. Giving up loses the rows still queued, which is the same
// outcome as being killed, and only after having tried.
func (w *LogWriter) CloseWithin(limit time.Duration) bool {
	w.closeOnce.Do(func() {
		w.closeMu.Lock()
		w.closed = true
		w.closeMu.Unlock()
		close(w.entries)
	})

	if limit <= 0 {
		<-w.done
		return true
	}

	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-w.done:
		return true
	case <-timer.C:
		slog.Error("request log queue did not drain before shutdown gave up",
			"waited", limit)
		return false
	}
}

func (w *LogWriter) run(ctx context.Context, database *sql.DB, logStats *db.LogStatsCache) {
	defer close(w.done)

	batch := make([]LogEntry, 0, logWriteBatchSize)
	for {
		entry, ok := <-w.entries
		if !ok {
			return
		}
		batch = append(batch, entry)

		// Collect further entries until the batch fills or the window closes, so
		// bursts commit in one transaction.
		flushDeadline := time.NewTimer(logWriteBatchInterval)
		channelClosed := false
	collect:
		for len(batch) < logWriteBatchSize {
			select {
			case <-flushDeadline.C:
				break collect
			case next, stillOpen := <-w.entries:
				if !stillOpen {
					channelClosed = true
					break collect
				}
				batch = append(batch, next)
			}
		}
		flushDeadline.Stop()

		entries := batch
		batch = make([]LogEntry, 0, logWriteBatchSize)
		w.flush(ctx, database, logStats, entries)

		if channelClosed {
			return
		}
	}
}

func (w *LogWriter) flush(ctx context.Context, database *sql.DB, logStats *db.LogStatsCache,
	entries []LogEntry) {
	entryCount := uint64(len(entries))
	w.metrics.RecordLogDequeue(entryCount)

	// The hold each entry took at enqueue is released however the write turns
	// out: a committed row is in the stored total, and an abandoned one never
	// will be.
	defer func() {
		for _, entry := range entries {
			if tokenID, used, ok := quotaUsage(entry); ok {
				w.quotas.Settle(tokenID, used)
			}
		}
	}()

	// Shutdown cancels the jobs context, but the batch it interrupts still has
	// to reach the database: these rows carry the quota increments, so a write
	// abandoned mid-shutdown hands that usage back for free. The deadline keeps
	// a stuck write from holding shutdown open instead.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), logWriteTimeout)
	defer cancel()

	startedAt := time.Now()
	records, err := insertLogBatchWithRetry(writeCtx, database, entries)
	if err != nil {
		w.metrics.RecordLogWriteFailureCount(entryCount)
		slog.Error("failed to persist request logs", "error", err, "entry_count", entryCount)
	} else {
		w.metrics.RecordLogWritten(entryCount)
		w.publish(writeCtx, database, logStats, records)
	}
	if time.Since(startedAt) >= slowDBOperationThreshold {
		w.metrics.RecordSlowDBOperation()
	}
}

// publish folds committed rows into the stats cache and notifies subscribers.
//
// insertLogBatchWithRetry only returns after its SQLite transaction commits.
// Never publish from Schedule, or a dropped or rolled-back row could appear in
// the live console.
func (w *LogWriter) publish(ctx context.Context, database *sql.DB, logStats *db.LogStatsCache,
	records []persistedLogRecord) {
	if len(records) == 0 {
		return
	}

	stats := make([]db.PersistedLogStats, 0, len(records))
	for _, record := range records {
		stats = append(stats, record.stats)
	}
	logStats.RecordPersistedEntries(stats)

	var recentRate *db.RecentLogRate
	if rate, err := db.RecentOneMinuteLogRate(ctx, database); err == nil {
		recentRate = &rate
	} else {
		slog.Warn("failed to calculate recent log rate for live log event", "error", err)
	}

	for _, record := range records {
		event := record.event
		if recentRate != nil {
			requestCount := recentRate.RequestCount
			totalTokens := recentRate.TotalTokens
			event.RecentRPM = &requestCount
			event.RecentTPM = &totalTokens
		}
		w.events.publish(event)
	}
}

func insertLogBatchWithRetry(ctx context.Context, database *sql.DB, entries []LogEntry) ([]persistedLogRecord, error) {
	if len(entries) == 0 {
		return nil, nil
	}

	for attempt := 0; ; attempt++ {
		records, err := insertLogBatch(ctx, database, entries)
		if err == nil {
			return records, nil
		}
		if !isDatabaseLocked(err) || attempt+1 >= logWriteMaxAttempts {
			return nil, err
		}
		delay := logWriteRetryBaseDelay << min(attempt, 4)
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(delay):
		}
	}
}

// isDatabaseLocked reports a contended write that is worth retrying.
func isDatabaseLocked(err error) bool {
	var appErr *apperr.AppError
	if errors.As(err, &appErr) {
		err = appErr.Unwrap()
	}
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "database is locked") ||
		strings.Contains(err.Error(), "SQLITE_BUSY")
}

func insertLogBatch(ctx context.Context, database *sql.DB, entries []LogEntry) ([]persistedLogRecord, error) {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer tx.Rollback()

	records := make([]persistedLogRecord, 0, len(entries))
	for _, entry := range entries {
		now := time.Now().UTC()
		createdAt := now.Format(models.TimestampFormat)
		streamInt := int32(0)
		if entry.Stream {
			streamInt = 1
		}
		clientType := "unknown"
		if entry.ClientType != nil {
			clientType = *entry.ClientType
		}
		requestPayload := encodeSnapshotPair(entry.DownstreamRequest, entry.UpstreamRequest)
		responsePayload := encodeSnapshotPair(entry.UpstreamResponse, entry.DownstreamResponse)

		result, err := tx.ExecContext(ctx, `INSERT INTO request_logs
        (method, path, downstream_token_id, downstream_token_name, client_type,
         upstream_id, upstream_name, model, request_model, upstream_model,
         reasoning_effort, response_reasoning_effort, stream, status_code,
         prompt_tokens, completion_tokens, total_tokens,
         prompt_cached_tokens, cache_creation_tokens, completion_reasoning_tokens,
         duration_ms, first_token_ms,
         request_uid, attempt_index, pre_upstream_ms, upstream_headers_ms,
         error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?)`,
			entry.Method, entry.Path, entry.DownstreamTokenID, entry.DownstreamTokenName,
			clientType, entry.UpstreamID, entry.UpstreamName, entry.Model,
			entry.RequestModel, entry.UpstreamModel, entry.ReasoningEffort,
			entry.ResponseReasoningEffort, streamInt, entry.StatusCode,
			entry.PromptTokens, entry.CompletionTokens, entry.TotalTokens,
			entry.PromptCachedTokens, entry.CacheCreationTokens,
			entry.CompletionReasoningTokens, entry.DurationMs, entry.FirstTokenMs,
			entry.RequestUID, entry.AttemptIndex, entry.PreUpstreamMs,
			entry.UpstreamHeadersMs, entry.Error, createdAt)
		if err != nil {
			return nil, apperr.Database(err)
		}
		logID, err := result.LastInsertId()
		if err != nil {
			return nil, apperr.Database(err)
		}

		_, err = tx.ExecContext(ctx, `INSERT INTO request_log_payloads
        (request_log_id, request_snapshot,
         upstream_request_override, upstream_request_is_override,
         response_snapshot,
         downstream_response_override, downstream_response_is_override)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
			logID, requestPayload.canonical, requestPayload.overrideValue,
			boolToInt64(requestPayload.isOverride), responsePayload.canonical,
			responsePayload.overrideValue, boolToInt64(responsePayload.isOverride))
		if err != nil {
			return nil, apperr.Database(err)
		}

		// The quota counter advances with the log row, so a committed request is
		// always accounted for exactly once. A request that carried no usage, or
		// came from a deleted token, contributes nothing.
		//
		// Through quotaUsage, so the increment applied here and the hold taken
		// at enqueue cannot drift apart. They were two copies of one condition,
		// which is only correct for as long as nobody edits one of them.
		if tokenID, used, ok := quotaUsage(entry); ok {
			_, err := tx.ExecContext(ctx,
				"UPDATE api_tokens SET used_tokens = used_tokens + ? WHERE id = ?",
				used, tokenID)
			if err != nil {
				return nil, apperr.Database(err)
			}
		}

		records = append(records, persistedLogRecord{
			stats: db.PersistedLogStats{
				ID:                   logID,
				CreatedAtUnixSeconds: now.Unix(),
				TotalTokens:          int32PtrToInt64Ptr(entry.TotalTokens),
				PromptTokens:         int32PtrToInt64Ptr(entry.PromptTokens),
				PromptCachedTokens:   int32PtrToInt64Ptr(entry.PromptCachedTokens),
			},
			event: LogStreamEvent{
				Log: models.RequestLogOut{
					ID:                        logID,
					CreatedAt:                 createdAt,
					Method:                    entry.Method,
					Path:                      entry.Path,
					DownstreamTokenID:         entry.DownstreamTokenID,
					DownstreamTokenName:       entry.DownstreamTokenName,
					ClientType:                clientType,
					UpstreamID:                entry.UpstreamID,
					UpstreamName:              entry.UpstreamName,
					Model:                     entry.Model,
					RequestModel:              entry.RequestModel,
					UpstreamModel:             entry.UpstreamModel,
					ReasoningEffort:           entry.ReasoningEffort,
					ResponseReasoningEffort:   entry.ResponseReasoningEffort,
					Stream:                    streamInt,
					StatusCode:                entry.StatusCode,
					PromptTokens:              entry.PromptTokens,
					CompletionTokens:          entry.CompletionTokens,
					TotalTokens:               entry.TotalTokens,
					PromptCachedTokens:        entry.PromptCachedTokens,
					CacheCreationTokens:       entry.CacheCreationTokens,
					CompletionReasoningTokens: entry.CompletionReasoningTokens,
					DurationMs:                entry.DurationMs,
					FirstTokenMs:              entry.FirstTokenMs,
					RequestUID:                entry.RequestUID,
					AttemptIndex:              entry.AttemptIndex,
					PreUpstreamMs:             entry.PreUpstreamMs,
					UpstreamHeadersMs:         entry.UpstreamHeadersMs,
					Error:                     entry.Error,
				},
			},
		})
	}

	if err := tx.Commit(); err != nil {
		return nil, apperr.Database(err)
	}
	return records, nil
}

// encodedSnapshotPair is one canonical snapshot plus the peer, retained only
// when it differs.
type encodedSnapshotPair struct {
	canonical     any
	overrideValue any
	isOverride    bool
}

// encodeSnapshotPair stores one canonical snapshot and only retains the peer
// when it differs.
//
// The explicit flag is intentionally independent of overrideValue: a null
// override with the flag set means the peer snapshot was absent, while a clear
// flag means it was identical to the canonical snapshot.
func encodeSnapshotPair(canonical, peer json.RawMessage) encodedSnapshotPair {
	isOverride := !snapshotsEqual(canonical, peer)

	pair := encodedSnapshotPair{isOverride: isOverride}
	if canonical != nil {
		pair.canonical = string(canonical)
	}
	if isOverride && peer != nil {
		pair.overrideValue = string(peer)
	}
	return pair
}

// snapshotsEqual compares two snapshots by their serialized form, which is how
// they are stored and compared downstream.
func snapshotsEqual(left, right json.RawMessage) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return string(left) == string(right)
}

func boolToInt64(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func int32PtrToInt64Ptr(value *int32) *int64 {
	if value == nil {
		return nil
	}
	converted := int64(*value)
	return &converted
}

// eventBroker fans committed log rows out to the console's SSE subscribers.
type eventBroker struct {
	mu          sync.Mutex
	subscribers map[int64]chan LogStreamEvent
	nextID      int64
}

func newEventBroker() *eventBroker {
	return &eventBroker{subscribers: map[int64]chan LogStreamEvent{}}
}

func (b *eventBroker) subscribe() (<-chan LogStreamEvent, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()

	id := b.nextID
	b.nextID++
	events := make(chan LogStreamEvent, logEventChannelCapacity)
	b.subscribers[id] = events

	return events, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if existing, ok := b.subscribers[id]; ok {
			delete(b.subscribers, id)
			close(existing)
		}
	}
}

// publish delivers without blocking. A subscriber that cannot keep up loses the
// event rather than stalling the writer; the database stays authoritative and
// the console reloads from it.
func (b *eventBroker) publish(event LogStreamEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, events := range b.subscribers {
		select {
		case events <- event:
		default:
		}
	}
}

// ── Snapshots ────────────────────────────────────────────────────────────────

// SnapshotRequest builds a request snapshot with redacted headers and a
// truncated body.
func SnapshotRequest(method, url string, headers map[string]string, body []byte,
	bodyMaxBytes int) json.RawMessage {
	snapshot := map[string]any{
		"method":  method,
		"url":     url,
		"headers": redactHeaders(headers),
	}
	if body != nil {
		snapshot["body"] = truncateBody(body, bodyMaxBytes)
	}
	return mustMarshalSnapshot(snapshot)
}

// SnapshotResponse builds a response snapshot with redacted headers and a
// truncated body.
func SnapshotResponse(status int, headers map[string]string, body []byte,
	bodyMaxBytes int) json.RawMessage {
	length := -1
	if body != nil {
		length = len(body)
	}
	return SnapshotResponseWithBodyLength(status, headers, body, length, bodyMaxBytes)
}

// SnapshotResponseWithBodyLength builds a response snapshot from a bounded body
// prefix while retaining the original response length. A negative
// bodyByteLength means the prefix is the whole body.
func SnapshotResponseWithBodyLength(status int, headers map[string]string, body []byte,
	bodyByteLength, bodyMaxBytes int) json.RawMessage {
	snapshot := map[string]any{
		"status_code": status,
		"status":      status,
		"headers":     redactHeaders(headers),
	}
	if body != nil {
		length := bodyByteLength
		if length < 0 {
			length = len(body)
		}
		snapshot["body"] = truncateBodyWithLength(body, bodyMaxBytes, length)
	}
	return mustMarshalSnapshot(snapshot)
}

// mustMarshalSnapshot serializes a snapshot built from types that always
// marshal. A failure here would mean a programming error, so it degrades to an
// empty object rather than failing the request being logged.
func mustMarshalSnapshot(snapshot map[string]any) json.RawMessage {
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		slog.Error("could not serialize a log snapshot", "error", err)
		return json.RawMessage(`{}`)
	}
	return encoded
}

func redactHeaders(headers map[string]string) map[string]string {
	redacted := make(map[string]string, len(headers))
	for name, value := range headers {
		if IsSensitiveHeaderName(name) {
			redacted[name] = "***REDACTED***"
			continue
		}
		redacted[name] = value
	}
	return redacted
}

func truncateBody(body []byte, budget int) map[string]any {
	return truncateBodyWithLength(body, budget, len(body))
}

// truncateBodyWithLength renders a body into a frontend-friendly object:
//   - text UTF-8: {text, byte_length}
//   - binary or oversized: {base64, encoding, byte_length, truncated}
func truncateBodyWithLength(body []byte, budget, originalByteLength int) map[string]any {
	if budget == 0 {
		return map[string]any{"cleared": true, "byte_length": originalByteLength}
	}
	if len(body) == 0 {
		return map[string]any{"text": "", "byte_length": originalByteLength}
	}

	// Text is cut on a UTF-8 boundary. Binary bytes are sliced before encoding.
	slice := body[:min(len(body), budget)]
	if text, ok := validTextPrefix(body, slice, originalByteLength); ok {
		snapshot := map[string]any{"text": text, "byte_length": originalByteLength}
		if len(text) < originalByteLength {
			snapshot["truncated"] = true
		}
		return snapshot
	}

	snapshot := map[string]any{
		"base64":      base64.StdEncoding.EncodeToString(slice),
		"encoding":    "base64",
		"byte_length": originalByteLength,
	}
	if len(slice) < originalByteLength {
		snapshot["truncated"] = true
	}
	return snapshot
}

// validTextPrefix returns the longest valid UTF-8 prefix of slice, or ok=false
// when the body is not text at all.
func validTextPrefix(body, slice []byte, originalByteLength int) (string, bool) {
	if len(body) == originalByteLength {
		// The whole body is present, so it can be validated as one string before
		// the prefix is cut back to a rune boundary. An index equal to the length
		// is already a boundary, which is why the guard stops there.
		if !utf8.Valid(body) {
			return "", false
		}
		cutoff := len(slice)
		for cutoff > 0 && cutoff < len(body) && !utf8.RuneStart(body[cutoff]) {
			cutoff--
		}
		return string(body[:cutoff]), true
	}

	// Only a prefix of a longer body is available. A trailing partial rune is
	// expected here, so it is dropped rather than treated as binary.
	cutoff := len(slice)
	for cutoff > 0 && !utf8.Valid(slice[:cutoff]) {
		cutoff--
	}
	if cutoff == 0 && len(slice) > 0 {
		return "", false
	}
	return string(slice[:cutoff]), true
}

// ── Background cleanup ──────────────────────────────────────────────────────

// RunCleanupLoop keeps full bodies near the configured row limit and performs
// the heavier retention and statistics work hourly.
//
// The runtime policy is read through a getter rather than a shared lock, so the
// loop always sees the latest console edit without owning the settings.
func RunCleanupLoop(ctx context.Context, database *sql.DB, settings func() models.RuntimeSettings,
	metrics LogMetricsRecorder, logStats *db.LogStatsCache) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(cleanupStartupDelay):
	}

	ticker := time.NewTicker(logBodyCleanupInterval)
	defer ticker.Stop()
	nextRetentionCleanup := time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		now := time.Now()
		runRetentionCleanup := !now.Before(nextRetentionCleanup)
		if runRetentionCleanup {
			nextRetentionCleanup = now.Add(logRetentionCleanupInterval)
		}

		current := settings()
		RunCleanupPass(ctx, database, &current, metrics, logStats, runRetentionCleanup)
	}
}

// RunCleanupPass performs one cleanup cycle.
func RunCleanupPass(ctx context.Context, database *sql.DB, settings *models.RuntimeSettings,
	metrics LogMetricsRecorder, logStats *db.LogStatsCache, runRetentionCleanup bool) {
	cleanupStartedAt := time.Now()
	cleanupSucceeded := true
	metrics.BeginCleanup()

	// A pass interrupted by shutdown is neither a success nor a fault: it
	// reports what stopped it and the next start picks the work up. Counting it
	// as an error would make every restart look like a cleanup failure, and
	// counting it as success would claim work that was not done.
	if _, err := db.ClearOldLogBodies(ctx, database, settings.LogBodyKeepCount, metrics); err != nil {
		if errors.Is(err, context.Canceled) {
			slog.Info("log body cleanup stopped for shutdown")
			return
		}
		cleanupSucceeded = false
		slog.Error("clearing old log bodies failed", "error", err)
	}

	if runRetentionCleanup {
		deleteStartedAt := time.Now()
		if err := db.DeleteOldLogs(ctx, database, settings.LogRetentionDays); err != nil {
			cleanupSucceeded = false
			slog.Error("deleting old logs failed", "error", err)
		}
		if time.Since(deleteStartedAt) >= slowDBOperationThreshold {
			metrics.RecordSlowDBOperation()
		}

		statsRefreshStartedAt := time.Now()
		if err := logStats.RefreshFromDB(ctx, database); err != nil {
			cleanupSucceeded = false
			slog.Warn("request log statistics refresh after cleanup failed", "error", err)
		}
		if time.Since(statsRefreshStartedAt) >= slowDBOperationThreshold {
			metrics.RecordSlowDBOperation()
		}
	}

	reclaimStartedAt := time.Now()
	pagesReclaimed, err := db.ReclaimFreePages(ctx, database, incrementalVacuumMaxPages)
	switch {
	case err != nil:
		cleanupSucceeded = false
		slog.Error("incremental SQLite vacuum failed", "error", err)
	case pagesReclaimed > 0:
		slog.Debug("reclaimed SQLite pages after log cleanup", "pages_reclaimed", pagesReclaimed)
	}
	if time.Since(reclaimStartedAt) >= slowDBOperationThreshold {
		metrics.RecordSlowDBOperation()
	}

	metrics.FinishCleanup(cleanupSucceeded, time.Since(cleanupStartedAt))
}
