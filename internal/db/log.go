package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/logbody"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const (
	// logBodyCleanupBatchSize is how many rows one batch clears.
	//
	// Clearing deletes a range of body records and flips a flag; no JSON is
	// parsed. A batch has to outpace a gateway that keeps writing: at eight rows
	// per 25ms an earlier version cleared about 320 a second, and a busier
	// gateway then grew the stored bodies without the keep-count policy ever
	// catching up.
	logBodyCleanupBatchSize  int64 = 1000
	logBodyCleanupBatchPause       = 25 * time.Millisecond
	// logDeleteBatchSize is how many expired log rows one delete removes.
	//
	// Larger than the body batch because the work per row is a delete rather
	// than a JSON rewrite, and retention has a whole window to get through.
	logDeleteBatchSize  int64 = 500
	logDeleteBatchPause       = 25 * time.Millisecond
	// actualModelExpression prefers the model actually sent to the upstream.
	// `model` is retained as a compatibility fallback for logs written before
	// `upstream_model` was added.
	actualModelExpression = "COALESCE(NULLIF(TRIM(upstream_model), ''), NULLIF(TRIM(model), ''))"
)

// failedRows is a failed request: no status, or one outside 2xx. 499 is the
// client hanging up, which is its own doing and not counted as a failure.
const failedRows = "(status_code IS NULL OR ((status_code < 200 OR status_code >= 300) AND status_code <> 499))"

// cancelledRows is a request the client hung up on.
const cancelledRows = "status_code = 499"

// failedStatus is failedRows for one status.
func failedStatus(status *int32) bool {
	return status == nil || ((*status < 200 || *status >= 300) && *status != 499)
}

// countedRows keeps the rows that are requests. A retried row is a failed
// attempt of a request whose outcome another row records: counted, it made one
// request with a retry look like two, one of them failed.
const countedRows = "retried = 0"

// logListColumns is the projection backing RequestLogOut.
const logListColumns = `id, created_at, method, path,
                downstream_token_id, downstream_token_name,
                client_ip, client_type,
                upstream_id, upstream_name, upstream_key_id, upstream_key_name,
                model, request_model, upstream_model,
                reasoning_effort, upstream_reasoning_effort, response_reasoning_effort,
                stream, status_code,
                prompt_tokens, completion_tokens, total_tokens,
                prompt_cached_tokens, cache_creation_tokens, completion_reasoning_tokens,
                duration_ms, first_token_ms,
                request_uid, attempt_index, pre_upstream_ms, upstream_headers_ms,
                failure_stage, failure_retryable,
                error, request_id, retried`

// LogTopWindow is a ranking window accepted by the top-stats endpoint.
type LogTopWindow int

const (
	LogTopWindowToday LogTopWindow = iota
	LogTopWindowOneDay
	LogTopWindowThreeDays
	LogTopWindowSevenDays
	LogTopWindowThirtyDays
	LogTopWindowAll
	LogTopWindowCustom
)

// ParseLogTopWindow maps a query value onto a window.
func ParseLogTopWindow(value string) (LogTopWindow, bool) {
	switch value {
	case "today":
		return LogTopWindowToday, true
	case "1d":
		return LogTopWindowOneDay, true
	case "3d":
		return LogTopWindowThreeDays, true
	case "7d":
		return LogTopWindowSevenDays, true
	case "30d":
		return LogTopWindowThirtyDays, true
	case "all":
		return LogTopWindowAll, true
	case "default":
		return LogTopWindowThirtyDays, true
	case "custom":
		return LogTopWindowCustom, true
	default:
		return 0, false
	}
}

func (w LogTopWindow) QueryValue() string {
	switch w {
	case LogTopWindowToday:
		return "today"
	case LogTopWindowOneDay:
		return "1d"
	case LogTopWindowThreeDays:
		return "3d"
	case LogTopWindowSevenDays:
		return "7d"
	case LogTopWindowThirtyDays:
		return "30d"
	case LogTopWindowAll:
		return "all"
	case LogTopWindowCustom:
		return "custom"
	default:
		return ""
	}
}

func (w LogTopWindow) cutoffExpression() string {
	switch w {
	case LogTopWindowToday:
		return "datetime('now', 'localtime', 'start of day', 'utc')"
	case LogTopWindowOneDay:
		return "datetime('now', '-1 day')"
	case LogTopWindowThreeDays:
		return "datetime('now', '-3 days')"
	case LogTopWindowSevenDays:
		return "datetime('now', '-7 days')"
	case LogTopWindowThirtyDays:
		return "datetime('now', '-30 days')"
	default:
		return ""
	}
}

// ResolveWindowRange expresses a preset window as the concrete [start, end)
// instants it covers, in the models.TimestampFormat UTC shape.
//
// The dashboard's presets are relative SQLite expressions evaluated at query
// time, which is fine for one aggregate but leaves a drill-down with nothing to
// carry: "最近 24 小时" names no instant. Resolving here rather than in the
// browser keeps one definition of where a window starts — notably 'today',
// whose midnight is the server's local one, not the viewer's — so the log page
// filters over the same rows the dashboard counted.
//
// LogTopWindowAll returns no bounds, and LogTopWindowCustom returns none either
// because its caller already holds the explicit range it parsed.
func ResolveWindowRange(window LogTopWindow, now time.Time) (start, end time.Time, ok bool) {
	var from time.Time
	switch window {
	case LogTopWindowToday:
		local := now.Local()
		from = time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	case LogTopWindowOneDay:
		from = now.AddDate(0, 0, -1)
	case LogTopWindowThreeDays:
		from = now.AddDate(0, 0, -3)
	case LogTopWindowSevenDays:
		from = now.AddDate(0, 0, -7)
	case LogTopWindowThirtyDays:
		from = now.AddDate(0, 0, -30)
	default:
		return time.Time{}, time.Time{}, false
	}
	// End is exclusive and the row being written this instant should be
	// included, so it rounds up to the next whole second rather than
	// truncating: created_at has second granularity, and a truncated bound
	// would drop everything logged during the current second.
	upper := now.UTC().Truncate(time.Second).Add(time.Second)
	return from.UTC().Truncate(time.Second), upper, true
}

func appendLogTimePredicate(query *strings.Builder, args []any, window LogTopWindow,
	startAt, endAt string) ([]any, error) {
	switch window {
	case LogTopWindowAll:
		query.WriteString("1 = 1")
	case LogTopWindowCustom:
		if startAt == "" || endAt == "" {
			return nil, apperr.BadRequest("custom window requires start_date and end_date")
		}
		query.WriteString("created_at >= ? AND created_at < ?")
		args = append(args, startAt, endAt)
	case LogTopWindowToday:
		// A caller that knows the operator's zone passes the start of their day;
		// without one, "today" is the server's.
		if startAt == "" {
			fmt.Fprintf(query, "created_at >= %s", window.cutoffExpression())
		} else {
			query.WriteString("created_at >= ?")
			args = append(args, startAt)
		}
	default:
		cutoff := window.cutoffExpression()
		if cutoff == "" {
			return nil, apperr.BadRequest("invalid log statistics window")
		}
		fmt.Fprintf(query, "created_at >= %s", cutoff)
	}
	return args, nil
}

// detachLogBatch bounds one pass of detachLogs.
const detachLogBatch = 5000

// detachLogs clears one row's references from request_logs in short
// transactions, ahead of deleting that row.
//
// ON DELETE SET NULL does the same inside the DELETE, as one statement holding
// the write lock throughout: 0.9s per 300k logs on a desktop. Past the
// five-second busy timeout an edit made meanwhile fails as "database is
// locked"; past the log writer's fifteen-second deadline a batch of logs is
// lost. The DELETE afterwards only has what arrived in between left to clear.
//
// column is one of this package's own column names, never caller input.
func detachLogs(ctx context.Context, database *sql.DB, column string, id int64) error {
	query := fmt.Sprintf(`UPDATE request_logs SET %[1]s = NULL
        WHERE id IN (SELECT id FROM request_logs WHERE %[1]s = ? LIMIT ?)`, column)
	for {
		result, err := database.ExecContext(ctx, query, id, detachLogBatch)
		if err != nil {
			return apperr.Database(err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return apperr.Database(err)
		}
		if affected < detachLogBatch {
			return nil
		}
	}
}

// LogFilter narrows a log listing. A nil field means the filter is not applied.
type LogFilter struct {
	UpstreamID        *int64
	DownstreamTokenID *int64
	Search            *string
	Status            *string
	ClientType        *string
	// Start and End bound created_at as [Start, End). Both carry the
	// models.TimestampFormat UTC shape created_at itself uses, so the
	// comparison is a plain string compare on a fixed-width zero-padded
	// layout. Callers normalize whatever the operator typed into that shape
	// before it reaches here; an RFC3339 literal with its 'T' and zone would
	// compare wrong rather than fail loudly.
	Start *string
	End   *string
	// Stream selects streaming or non-streaming requests.
	Stream *bool
	// MinDurationMs keeps rows that took at least this long. A row with no
	// recorded duration never matches: an unknown duration cannot be shown to
	// have crossed the threshold, and counting it would answer "slower than 3s?"
	// with requests that may have been instant.
	MinDurationMs *int64
}

const (
	LogStatus2xx   = "2xx"
	LogStatus4xx   = "4xx"
	LogStatus5xx   = "5xx"
	LogStatusOther = "other"
	LogStatusNone  = "none"
	LogStatusError = "error"
)

func ValidLogStatus(status string) bool {
	switch status {
	case LogStatus2xx, LogStatus4xx, LogStatus5xx, LogStatusOther, LogStatusNone, LogStatusError:
		return true
	default:
		return false
	}
}

// StatusMatches reports whether one status code belongs to a status category.
//
// It is the Go twin of the SQL the listing builds, so the live stream and the
// paginated list cannot disagree about what an error is. A nil code is a row
// that never got an HTTP status.
func StatusMatches(status string, code *int32) bool {
	if code == nil {
		return status == LogStatusNone || status == LogStatusError
	}
	value := *code
	switch status {
	case LogStatus2xx:
		return value >= 200 && value <= 299
	case LogStatus4xx:
		return value >= 400 && value <= 499
	case LogStatus5xx:
		return value >= 500 && value <= 599
	case LogStatusOther:
		return (value >= 100 && value <= 199) || (value >= 300 && value <= 399)
	case LogStatusNone:
		return false
	case LogStatusError:
		return failedStatus(code)
	default:
		return true
	}
}

// Matches reports whether a committed log row satisfies the filter.
//
// The live stream broadcasts every committed row, so without this the console's
// filters only applied to the paginated history and live events arrived
// unfiltered. Search compares the same fields as the SQL LIKE list.
func (f LogFilter) Matches(entry models.RequestLogOut) bool {
	// Both sides are the fixed-width UTC models.TimestampFormat, so ordering
	// by string is ordering by time. [Start, End) matches the SQL exactly.
	if f.Start != nil && entry.CreatedAt < *f.Start {
		return false
	}
	if f.End != nil && entry.CreatedAt >= *f.End {
		return false
	}
	if f.UpstreamID != nil && (entry.UpstreamID == nil || *entry.UpstreamID != *f.UpstreamID) {
		return false
	}
	if f.DownstreamTokenID != nil &&
		(entry.DownstreamTokenID == nil || *entry.DownstreamTokenID != *f.DownstreamTokenID) {
		return false
	}
	if f.ClientType != nil && entry.ClientType != *f.ClientType {
		return false
	}
	if f.Status != nil && !StatusMatches(*f.Status, entry.StatusCode) {
		return false
	}
	if f.Stream != nil && (entry.Stream != 0) != *f.Stream {
		return false
	}
	if f.MinDurationMs != nil &&
		(entry.DurationMs == nil || int64(*entry.DurationMs) < *f.MinDurationMs) {
		return false
	}
	if f.Search != nil {
		needle := strings.ToLower(*f.Search)
		fields := []*string{entry.Model, entry.RequestModel, entry.UpstreamModel,
			entry.UpstreamName, entry.DownstreamTokenName, entry.Error}
		matched := false
		for _, field := range fields {
			if field != nil && strings.Contains(strings.ToLower(*field), needle) {
				matched = true
				break
			}
		}
		if !matched {
			if strings.Contains(strconv.FormatInt(entry.ID, 10), needle) {
				matched = true
			} else if entry.StatusCode != nil &&
				strings.Contains(strconv.FormatInt(int64(*entry.StatusCode), 10), needle) {
				matched = true
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

// appendFilters adds the WHERE fragments and their bind values.
func (f LogFilter) appendFilters(query *strings.Builder, args []any) []any {
	// The range goes first because it is the only filter here an index can
	// serve (idx_request_logs_created_at, and the composites leading with
	// upstream_id/downstream_token_id). Everything below it — client_type,
	// status_code, the leading-wildcard LIKE — can only be evaluated per row,
	// so bounding created_at first is what keeps a filtered page from reading
	// the whole table.
	if f.Start != nil {
		query.WriteString(" AND created_at >= ?")
		args = append(args, *f.Start)
	}
	if f.End != nil {
		query.WriteString(" AND created_at < ?")
		args = append(args, *f.End)
	}
	if f.UpstreamID != nil {
		query.WriteString(" AND upstream_id = ?")
		args = append(args, *f.UpstreamID)
	}
	if f.DownstreamTokenID != nil {
		query.WriteString(" AND downstream_token_id = ?")
		args = append(args, *f.DownstreamTokenID)
	}
	if f.Search != nil {
		// The wildcards are escaped so an operator searching for a literal '%'
		// or '_' does not match every row.
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(*f.Search)
		pattern := "%" + escaped + "%"
		query.WriteString(` AND (LOWER(model) LIKE LOWER(?) ESCAPE '\'` +
			` OR LOWER(request_model) LIKE LOWER(?) ESCAPE '\'` +
			` OR LOWER(upstream_model) LIKE LOWER(?) ESCAPE '\'` +
			` OR LOWER(upstream_name) LIKE LOWER(?) ESCAPE '\'` +
			` OR LOWER(downstream_token_name) LIKE LOWER(?) ESCAPE '\'` +
			` OR LOWER(error) LIKE LOWER(?) ESCAPE '\'` +
			` OR CAST(id AS TEXT) LIKE ? ESCAPE '\'` +
			` OR CAST(status_code AS TEXT) LIKE ? ESCAPE '\')`)
		for range 8 {
			args = append(args, pattern)
		}
	}
	if f.Status != nil {
		switch *f.Status {
		case LogStatus2xx:
			query.WriteString(" AND status_code BETWEEN 200 AND 299")
		case LogStatus4xx:
			query.WriteString(" AND status_code BETWEEN 400 AND 499")
		case LogStatus5xx:
			query.WriteString(" AND status_code BETWEEN 500 AND 599")
		case LogStatusOther:
			query.WriteString(" AND status_code IS NOT NULL AND ((status_code BETWEEN 100 AND 199) OR (status_code BETWEEN 300 AND 399))")
		case LogStatusNone:
			query.WriteString(" AND status_code IS NULL")
		case LogStatusError:
			query.WriteString(" AND " + failedRows)
		}
	}
	if f.ClientType != nil {
		query.WriteString(" AND client_type = ?")
		args = append(args, *f.ClientType)
	}
	if f.Stream != nil {
		// The column is an INTEGER flag, so the bool is bound as 0/1 rather
		// than relying on the driver's mapping matching SQLite's storage.
		value := 0
		if *f.Stream {
			value = 1
		}
		query.WriteString(" AND stream = ?")
		args = append(args, value)
	}
	if f.MinDurationMs != nil {
		query.WriteString(" AND duration_ms IS NOT NULL AND duration_ms >= ?")
		args = append(args, *f.MinDurationMs)
	}
	return args
}

// logClientTypesQuery reads one index entry per client type: each step seeks
// the first type after the last one found, instead of reading every row.
const logClientTypesQuery = `WITH RECURSIVE seen(client_type) AS (
        SELECT MIN(client_type) FROM request_logs
        UNION ALL
        SELECT (SELECT MIN(client_type) FROM request_logs WHERE client_type > seen.client_type)
        FROM seen WHERE seen.client_type IS NOT NULL)
    SELECT client_type FROM seen WHERE client_type IS NOT NULL`

// LogClientTypes lists the client types the logs hold, in name order: what the
// log page's client filter offers, e.g. ["axonhub", "claude", "pi"].
func LogClientTypes(ctx context.Context, database *sql.DB) ([]string, error) {
	rows, err := database.QueryContext(ctx, logClientTypesQuery)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	types := []string{}
	for rows.Next() {
		var clientType string
		if err := rows.Scan(&clientType); err != nil {
			return nil, apperr.Database(err)
		}
		types = append(types, clientType)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return types, nil
}

// LogCursor is the keyset position a page continues from.
type LogCursor struct {
	CreatedAt string
	ID        int64
}

func scanLogListRow(row interface{ Scan(...any) error }) (models.RequestLogOut, error) {
	var entry models.RequestLogOut
	var downstreamTokenID, upstreamID sql.NullInt64
	var downstreamTokenName, upstreamName, model, requestModel, upstreamModel sql.NullString
	var reasoningEffort, upstreamReasoningEffort, responseReasoningEffort, logError sql.NullString
	var statusCode, promptTokens, completionTokens, totalTokens sql.NullInt64
	var promptCachedTokens, cacheCreationTokens, completionReasoningTokens sql.NullInt64
	var durationMs, firstTokenMs, requestID sql.NullInt64
	var requestUID, failureStage sql.NullString
	var attemptIndex, preUpstreamMs, upstreamHeadersMs sql.NullInt64
	var failureRetryable sql.NullBool
	var clientIP sql.NullString

	err := row.Scan(&entry.ID, &entry.CreatedAt, &entry.Method, &entry.Path,
		&downstreamTokenID, &downstreamTokenName, &clientIP, &entry.ClientType,
		&upstreamID, &upstreamName, &entry.UpstreamKeyID, &entry.UpstreamKeyName,
		&model, &requestModel, &upstreamModel,
		&reasoningEffort, &upstreamReasoningEffort, &responseReasoningEffort,
		&entry.Stream, &statusCode,
		&promptTokens, &completionTokens, &totalTokens,
		&promptCachedTokens, &cacheCreationTokens, &completionReasoningTokens,
		&durationMs, &firstTokenMs, &requestUID, &attemptIndex,
		&preUpstreamMs, &upstreamHeadersMs,
		&failureStage, &failureRetryable, &logError, &requestID, &entry.Retried)
	if err != nil {
		return entry, err
	}

	entry.RequestID = nullInt64Ptr(requestID)
	entry.DownstreamTokenID = nullInt64Ptr(downstreamTokenID)
	entry.UpstreamID = nullInt64Ptr(upstreamID)
	entry.DownstreamTokenName = nullStringPtr(downstreamTokenName)
	entry.ClientIP = nullStringPtr(clientIP)
	entry.UpstreamName = nullStringPtr(upstreamName)
	entry.Model = nullStringPtr(model)
	entry.RequestModel = nullStringPtr(requestModel)
	entry.UpstreamModel = nullStringPtr(upstreamModel)
	entry.ReasoningEffort = nullStringPtr(reasoningEffort)
	entry.UpstreamReasoningEffort = nullStringPtr(upstreamReasoningEffort)
	entry.ResponseReasoningEffort = nullStringPtr(responseReasoningEffort)
	entry.Error = nullStringPtr(logError)
	entry.StatusCode = nullInt32Ptr(statusCode)
	entry.PromptTokens = nullInt32Ptr(promptTokens)
	entry.CompletionTokens = nullInt32Ptr(completionTokens)
	entry.TotalTokens = nullInt32Ptr(totalTokens)
	entry.PromptCachedTokens = nullInt32Ptr(promptCachedTokens)
	entry.CacheCreationTokens = nullInt32Ptr(cacheCreationTokens)
	entry.CompletionReasoningTokens = nullInt32Ptr(completionReasoningTokens)
	entry.DurationMs = nullInt32Ptr(durationMs)
	entry.FirstTokenMs = nullInt32Ptr(firstTokenMs)
	entry.RequestUID = nullStringPtr(requestUID)
	entry.AttemptIndex = nullInt32Ptr(attemptIndex)
	entry.PreUpstreamMs = nullInt32Ptr(preUpstreamMs)
	entry.UpstreamHeadersMs = nullInt32Ptr(upstreamHeadersMs)
	entry.FailureStage = nullStringPtr(failureStage)
	entry.FailureRetryable = nullBoolPtr(failureRetryable)
	return entry, nil
}

// nullBoolPtr keeps a NULL verdict distinct from a stored false. A false says
// the gateway judged the failure unretryable; a NULL says there was no failure
// to judge, or the row predates the field.
func nullBoolPtr(value sql.NullBool) *bool {
	if !value.Valid {
		return nil
	}
	converted := value.Bool
	return &converted
}

// LogQueryTimeout bounds how long one log listing may run.
//
// The status and search filters cannot use an index: status_code has none, and
// the search is a leading-wildcard LIKE, which nothing can. LIMIT bounds the
// rows returned, not the rows examined, so a filter matching little or nothing
// reads the whole table — holding one of the few pooled connections while the
// proxy path waits for one. The deadline turns that into an error the operator
// sees rather than a stall the gateway absorbs.
const LogQueryTimeout = 10 * time.Second

// ListLogs returns one page, newest first. A cursor takes precedence over the
// offset, so a page boundary stays stable while new rows arrive.
func ListLogs(ctx context.Context, database *sql.DB, limit, offset int32,
	cursor *LogCursor, filter LogFilter) ([]models.RequestLogOut, error) {
	ctx, cancel := context.WithTimeout(ctx, LogQueryTimeout)
	defer cancel()

	var query strings.Builder
	query.WriteString("SELECT " + logListColumns + " FROM request_logs WHERE 1 = 1")

	args := filter.appendFilters(&query, nil)
	if cursor != nil {
		query.WriteString(" AND (created_at < ? OR (created_at = ? AND id < ?))")
		args = append(args, cursor.CreatedAt, cursor.CreatedAt, cursor.ID)
	}
	query.WriteString(" ORDER BY created_at DESC, id DESC LIMIT ?")
	args = append(args, limit)
	if cursor == nil {
		query.WriteString(" OFFSET ?")
		args = append(args, offset)
	}

	rows, err := database.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	entries := []models.RequestLogOut{}
	for rows.Next() {
		entry, err := scanLogListRow(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return entries, nil
}

// GetLogDetail returns one log with its captured payloads, or ok=false. A row
// that belongs to a request with several attempts lists them all.
func GetLogDetail(ctx context.Context, database *sql.DB, logID int64) (models.RequestLogDetailOut, bool, error) {
	var detail models.RequestLogDetailOut
	row := database.QueryRowContext(ctx,
		"SELECT "+logListColumns+" FROM request_logs WHERE id = ?", logID)
	entry, err := scanLogListRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return detail, false, nil
	}
	if err != nil {
		return detail, false, apperr.Database(err)
	}
	detail.RequestLogOut = entry

	if entry.RequestID != nil {
		attempts, err := requestAttempts(ctx, database, *entry.RequestID)
		if err != nil {
			return detail, false, err
		}
		// One row is the whole request; there is no chain to show.
		if len(attempts) > 1 {
			detail.Attempts = attempts
		}
	}

	snapshots, found, err := loadLogSnapshots(ctx, database, logID,
		logbody.SlotDownstreamRequest, logbody.SlotUpstreamRequest,
		logbody.SlotUpstreamResponse, logbody.SlotDownstreamResponse)
	if err != nil || !found {
		// Not found here means the log was deleted between the two reads.
		return detail, false, err
	}
	detail.DownstreamRequest = snapshots[logbody.SlotDownstreamRequest]
	detail.UpstreamRequest = snapshots[logbody.SlotUpstreamRequest]
	detail.UpstreamResponse = snapshots[logbody.SlotUpstreamResponse]
	detail.DownstreamResponse = snapshots[logbody.SlotDownstreamResponse]
	return detail, true, nil
}

// LogSnapshotField names one of the four captured payloads.
type LogSnapshotField string

const (
	LogSnapshotDownstreamRequest  LogSnapshotField = "downstream_request"
	LogSnapshotUpstreamRequest    LogSnapshotField = "upstream_request"
	LogSnapshotUpstreamResponse   LogSnapshotField = "upstream_response"
	LogSnapshotDownstreamResponse LogSnapshotField = "downstream_response"
)

// ParseLogSnapshotField maps a URL segment onto a field, or ok=false.
func ParseLogSnapshotField(name string) (LogSnapshotField, bool) {
	switch field := LogSnapshotField(name); field {
	case LogSnapshotDownstreamRequest, LogSnapshotUpstreamRequest,
		LogSnapshotUpstreamResponse, LogSnapshotDownstreamResponse:
		return field, true
	}
	return "", false
}

// snapshotSlots places each field in a stored body record.
var snapshotSlots = map[LogSnapshotField]int{
	LogSnapshotDownstreamRequest:  logbody.SlotDownstreamRequest,
	LogSnapshotUpstreamRequest:    logbody.SlotUpstreamRequest,
	LogSnapshotUpstreamResponse:   logbody.SlotUpstreamResponse,
	LogSnapshotDownstreamResponse: logbody.SlotDownstreamResponse,
}

// GetLogSnapshot returns one captured payload, or ok=false when the log is
// missing. A log without that payload is found with a nil snapshot.
//
// The console opens a log with its metadata already in hand and fetches each
// payload as the reader asks for it, so this reads only the chunks that
// payload needs instead of all four bodies.
func GetLogSnapshot(ctx context.Context, database *sql.DB, logID int64, field LogSnapshotField) (json.RawMessage, bool, error) {
	slot, ok := snapshotSlots[field]
	if !ok {
		return nil, false, apperr.BadRequest("unknown snapshot field")
	}
	snapshots, found, err := loadLogSnapshots(ctx, database, logID, slot)
	if err != nil || !found {
		return nil, found, err
	}
	return snapshots[slot], true, nil
}

// topRanking is one ranking of a window's facts: grouped by key, ordered by
// metric. Channels group by upstream_id so renamed or same-named channels stay
// apart; models by the name that went upstream.
type topRanking struct {
	// key is the facts column ranked by; empty values are left out.
	key, keyEmpty string
	// name is the label shown; metric what the ranking counts.
	name, metric string
	// latency adds average duration and error rate (the request ranking of
	// models). exposeID surfaces upstream_id as id (channel rankings).
	latency, exposeID bool
}

// channelNameAggregate prefers a channel's stored name, else "#<id>".
const channelNameAggregate = "MAX(CASE WHEN upstream_name <> '' THEN upstream_name ELSE '#' || upstream_id END)"

// tokenNameExpression prefers a non-empty downstream_token_name snapshot, else "#<id>".
const tokenNameExpression = `CASE
              WHEN downstream_token_name IS NOT NULL AND TRIM(downstream_token_name) <> '' THEN TRIM(downstream_token_name)
              ELSE '#' || downstream_token_id
           END`

const modelSourceFilter = "COALESCE(NULLIF(TRIM(upstream_model), ''), NULLIF(TRIM(model), '')) IS NOT NULL"

const tokenMetricFilter = "total_tokens IS NOT NULL AND total_tokens > 0"

// topRankings: models count requests, channels every attempt they took, and
// token rankings every token spent.
var topRankings = [4]topRanking{
	{key: "model", keyEmpty: "''", name: "MAX(model)", metric: "SUM(requests)", latency: true},
	{key: "upstream_id", keyEmpty: "0", name: channelNameAggregate, metric: "SUM(attempts)", exposeID: true},
	{key: "model", keyEmpty: "''", name: "MAX(model)", metric: "SUM(total_tokens)"},
	{key: "upstream_id", keyEmpty: "0", name: channelNameAggregate, metric: "SUM(total_tokens)", exposeID: true},
}

// TopLogStats ranks models and channels by request count and token usage.
func TopLogStats(ctx context.Context, database *sql.DB, window LogTopWindow, limit int64) (models.RequestLogTopStatsOut, error) {
	return topLogStats(ctx, database, window, "", "", limit)
}

// TopLogStatsRange ranks logs in a window the caller resolved: a custom
// interval, or "today" from the operator's own midnight.
func TopLogStatsRange(ctx context.Context, database *sql.DB, window LogTopWindow,
	startAt, endAt string, limit int64) (models.RequestLogTopStatsOut, error) {
	return topLogStats(ctx, database, window, startAt, endAt, limit)
}

// TopLogStatsCustom ranks logs in the half-open UTC interval [startAt, endAt).
func TopLogStatsCustom(ctx context.Context, database *sql.DB, startAt, endAt string,
	limit int64) (models.RequestLogTopStatsOut, error) {
	return topLogStats(ctx, database, LogTopWindowCustom, startAt, endAt, limit)
}

// topLogStats reads stats_hourly for the window's whole hours and the logs for
// the part hours at its edges.
func topLogStats(ctx context.Context, database *sql.DB, window LogTopWindow,
	startAt, endAt string, limit int64) (models.RequestLogTopStatsOut, error) {
	limit = min(max(limit, 1), 20)
	span, err := resolveStatsSpan(window, startAt, endAt, time.Now())
	if err != nil {
		return models.RequestLogTopStatsOut{}, err
	}

	var rankings [6][]models.RequestLogTopItemOut
	for i, ranking := range topRankings {
		items, err := topItems(ctx, database, span, ranking, limit)
		if err != nil {
			return models.RequestLogTopStatsOut{}, err
		}
		rankings[i] = items
	}

	for i, byTokens := range []bool{false, true} {
		items, err := topTokenItems(ctx, database, window, startAt, endAt, byTokens, limit)
		if err != nil {
			return models.RequestLogTopStatsOut{}, err
		}
		rankings[4+i] = items
	}

	return models.RequestLogTopStatsOut{
		Window:        window.QueryValue(),
		Models:        rankings[0],
		Channels:      rankings[1],
		ModelTokens:   rankings[2],
		ChannelTokens: rankings[3],
		Tokens:        rankings[4],
		TokenTokens:   rankings[5],
	}, nil
}

// topTokenItems ranks token identities, which the channel/model hourly facts
// do not carry. Request rankings skip retried attempts; token usage includes them.
func topTokenItems(ctx context.Context, database *sql.DB, window LogTopWindow,
	startAt, endAt string, byTokens bool, limit int64) ([]models.RequestLogTopItemOut, error) {
	var predicate strings.Builder
	args, err := appendLogTimePredicate(&predicate, nil, window, startAt, endAt)
	if err != nil {
		return nil, err
	}
	predicate.WriteString(" AND downstream_token_id IS NOT NULL")
	metric, latency := "COUNT(*)", ""
	if byTokens {
		metric = "SUM(total_tokens)"
		predicate.WriteString(" AND " + tokenMetricFilter)
	} else {
		predicate.WriteString(" AND " + countedRows)
		latency = ", AVG(CASE WHEN duration_ms >= 0 THEN duration_ms END), AVG(CASE WHEN " +
			failedRows + " THEN 1.0 ELSE 0.0 END)"
	}
	query := "SELECT MAX(" + tokenNameExpression + ") AS name, " + metric +
		" AS count, downstream_token_id" + latency + " FROM request_logs WHERE " +
		predicate.String() + " GROUP BY downstream_token_id HAVING count > 0" +
		" ORDER BY count DESC, name COLLATE NOCASE ASC LIMIT ?"
	rows, err := database.QueryContext(ctx, query, append(args, limit)...)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()
	items := []models.RequestLogTopItemOut{}
	for rows.Next() {
		var item models.RequestLogTopItemOut
		var id int64
		var avgDuration, errorRate sql.NullFloat64
		dest := []any{&item.Name, &item.Count, &id}
		if !byTokens {
			dest = append(dest, &avgDuration, &errorRate)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, apperr.Database(err)
		}
		item.ID = &id
		if avgDuration.Valid {
			value := avgDuration.Float64
			item.AvgDurationMs = &value
		}
		if errorRate.Valid {
			value := errorRate.Float64
			item.ErrorRate = &value
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return items, nil
}

func topItems(ctx context.Context, database *sql.DB, span statsSpan, ranking topRanking,
	limit int64) ([]models.RequestLogTopItemOut, error) {
	id := "NULL"
	if ranking.exposeID {
		id = "upstream_id"
	}
	latency := ""
	if ranking.latency {
		latency = `, SUM(duration_sum) * 1.0 / NULLIF(SUM(duration_count), 0),
            SUM(errors) * 1.0 / NULLIF(SUM(requests), 0)`
	}
	source, args := statsFacts(span)
	query := fmt.Sprintf(`SELECT %s AS name, %s AS count, %s%s
        FROM %s WHERE %s <> %s
        GROUP BY %s HAVING count > 0
        ORDER BY count DESC, name COLLATE NOCASE ASC LIMIT ?`,
		ranking.name, ranking.metric, id, latency, source, ranking.key, ranking.keyEmpty, ranking.key)

	rows, err := database.QueryContext(ctx, query, append(args, limit)...)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	items := []models.RequestLogTopItemOut{}
	for rows.Next() {
		var item models.RequestLogTopItemOut
		var upstreamID sql.NullInt64
		var avgDuration, errorRate sql.NullFloat64
		destination := []any{&item.Name, &item.Count, &upstreamID}
		if ranking.latency {
			destination = append(destination, &avgDuration, &errorRate)
		}
		if err := rows.Scan(destination...); err != nil {
			return nil, apperr.Database(err)
		}
		if upstreamID.Valid {
			value := upstreamID.Int64
			item.ID = &value
		}
		if avgDuration.Valid {
			value := avgDuration.Float64
			item.AvgDurationMs = &value
		}
		if errorRate.Valid {
			value := errorRate.Float64
			item.ErrorRate = &value
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return items, nil
}

// CleanupMetricsRecorder is the metrics subset log cleanup reports to.
type CleanupMetricsRecorder interface {
	RecordSlowDBOperation()
	RecordCleanupBatch(rowsCleared uint64)
}

// ClearOldLogBodies drops stored bodies beyond the newest keepCount rows,
// working in bounded batches so the write lock is never held for long.
func ClearOldLogBodies(ctx context.Context, database *sql.DB, keepCount int64,
	recorder CleanupMetricsRecorder) (uint64, error) {
	var totalAffected uint64
	for {
		batchStartedAt := time.Now()
		affected, err := clearOldLogBodiesBatch(ctx, database, keepCount, logBodyCleanupBatchSize)
		if err != nil {
			return totalAffected, err
		}
		if recorder != nil {
			if time.Since(batchStartedAt) >= slowDBOperationThreshold {
				recorder.RecordSlowDBOperation()
			}
			recorder.RecordCleanupBatch(affected)
		}
		totalAffected += affected

		if affected == 0 || affected < uint64(logBodyCleanupBatchSize) {
			return totalAffected, nil
		}

		select {
		case <-ctx.Done():
			// Shutdown, not completion. Reported as such so the cleanup pass
			// does not record a successful run it did not finish.
			return totalAffected, ctx.Err()
		case <-time.After(logBodyCleanupBatchPause):
		}
	}
}

// clearOldLogBodiesBatch drops the bodies of up to batchSize of the oldest rows
// outside the newest keepCount that still have them.
//
// The window is counted on the partial index of rows with bodies, by id: the
// keepCount-th newest of them is the threshold, and everything below it goes.
// Dropping a row's bodies deletes its body record, which frees the space once
// CollectLogChunks takes the chunks only it listed; the metadata stays.
func clearOldLogBodiesBatch(ctx context.Context, database *sql.DB, keepCount, batchSize int64) (uint64, error) {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return 0, apperr.Database(err)
	}
	defer tx.Rollback()

	var threshold int64
	err = tx.QueryRowContext(ctx, `SELECT request_log_id FROM request_log_snapshots
       WHERE bodies_cleared = 0
       ORDER BY request_log_id DESC
       LIMIT 1 OFFSET ?`, keepCount-1).Scan(&threshold)
	if errors.Is(err, sql.ErrNoRows) {
		// Fewer rows than the window holds.
		return 0, nil
	}
	if err != nil {
		return 0, apperr.Database(err)
	}

	var first, last, count int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(MIN(request_log_id), 0),
              COALESCE(MAX(request_log_id), 0), COUNT(*)
       FROM (SELECT request_log_id FROM request_log_snapshots
             WHERE bodies_cleared = 0 AND request_log_id < ?
             ORDER BY request_log_id
             LIMIT ?)`, threshold, batchSize).Scan(&first, &last, &count)
	if err != nil {
		return 0, apperr.Database(err)
	}
	if count == 0 {
		return 0, nil
	}

	// Every row in [first, last] is below the threshold, so a range is exact.
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM request_log_bodies WHERE request_log_id BETWEEN ? AND ?", first, last); err != nil {
		return 0, apperr.Database(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE request_log_snapshots SET bodies_cleared = 1
       WHERE bodies_cleared = 0 AND request_log_id BETWEEN ? AND ?`, first, last); err != nil {
		return 0, apperr.Database(err)
	}
	if err := tx.Commit(); err != nil {
		return 0, apperr.Database(err)
	}
	return uint64(count), nil
}

// ReclaimFreePages returns free SQLite pages to the filesystem when incremental
// auto-vacuum is enabled.
//
// Existing databases need one full VACUUM after switching from NONE to
// INCREMENTAL; until then this safely acts as a no-op.
func ReclaimFreePages(ctx context.Context, database *sql.DB, maxPages uint32) (uint64, error) {
	if maxPages == 0 {
		return 0, nil
	}

	var autoVacuum int64
	if err := database.QueryRowContext(ctx, "PRAGMA auto_vacuum").Scan(&autoVacuum); err != nil {
		return 0, apperr.Database(err)
	}
	if autoVacuum != 2 {
		return 0, nil
	}

	var before int64
	if err := database.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&before); err != nil {
		return 0, apperr.Database(err)
	}
	if before == 0 {
		return 0, nil
	}

	if _, err := database.ExecContext(ctx, fmt.Sprintf("PRAGMA incremental_vacuum(%d)", maxPages)); err != nil {
		return 0, apperr.Database(err)
	}

	var after int64
	if err := database.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&after); err != nil {
		return 0, apperr.Database(err)
	}
	if after > before {
		return 0, nil
	}
	return uint64(before - after), nil
}

// DeleteOldLogs drops logs past the retention window in bounded batches.
//
// Deleting the whole window in one statement held the write lock for as long as
// that took, and the amount waiting is not bounded by anything the gateway
// controls: enabling retention for the first time, or shortening it from ten
// years to a week, presents every row at once. Meanwhile every proxied request's
// log write — and the quota increment it carries — queues behind it. Batching
// puts an upper bound on how long any one transaction can block them, at the
// cost of taking several to finish, which nothing depends on.
//
// The payload rows go with their parent through ON DELETE CASCADE, so only the
// parents are named here.
func DeleteOldLogs(ctx context.Context, database *sql.DB, retentionDays int64) error {
	for {
		affected, err := deleteOldLogsBatch(ctx, database, retentionDays, logDeleteBatchSize)
		if err != nil {
			return err
		}
		if affected < logDeleteBatchSize {
			return nil
		}

		// Yield the write lock between batches so a proxied request's log does
		// not wait out the whole cleanup. A cancellation is reported: taken as
		// done, the caller went on to queries the cancellation failed, and a
		// shutdown was logged as a cleanup error.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(logDeleteBatchPause):
		}
	}
}

// deleteOldLogsBatch removes up to batchSize expired rows and reports how many
// it deleted.
func deleteOldLogsBatch(ctx context.Context, database *sql.DB,
	retentionDays, batchSize int64) (int64, error) {
	result, err := database.ExecContext(ctx, `DELETE FROM request_logs
       WHERE id IN (
           SELECT id FROM request_logs
           WHERE created_at < datetime('now', '-' || ? || ' days')
           LIMIT ?
       )`, retentionDays, batchSize)
	if err != nil {
		return 0, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, apperr.Database(err)
	}
	return affected, nil
}

// LogAttempts lists the rows of the request logID belongs to, oldest first,
// itself included. A request that took one attempt, and a row from outside the
// proxy path, have nothing to list.
func LogAttempts(ctx context.Context, database *sql.DB, logID int64) ([]models.RequestLogOut, error) {
	var requestID sql.NullInt64
	err := database.QueryRowContext(ctx,
		"SELECT request_id FROM request_logs WHERE id = ?", logID).Scan(&requestID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !requestID.Valid) {
		return []models.RequestLogOut{}, nil
	}
	if err != nil {
		return nil, apperr.Database(err)
	}

	attempts, err := requestAttempts(ctx, database, requestID.Int64)
	if err != nil || len(attempts) > 1 {
		return attempts, err
	}
	return []models.RequestLogOut{}, nil
}

// requestAttempts lists the rows of one request in the order they were written:
// its failed attempts, then the row that records how it ended.
func requestAttempts(ctx context.Context, database *sql.DB, requestID int64) ([]models.RequestLogOut, error) {
	rows, err := database.QueryContext(ctx, "SELECT "+logListColumns+
		" FROM request_logs WHERE request_id = ? ORDER BY id LIMIT 50", requestID)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	attempts := []models.RequestLogOut{}
	for rows.Next() {
		attempt, err := scanLogListRow(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return attempts, nil
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullInt64Ptr(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func nullInt32Ptr(value sql.NullInt64) *int32 {
	if !value.Valid {
		return nil
	}
	converted := int32(value.Int64)
	return &converted
}
