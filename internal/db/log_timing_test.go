package db

import (
	"context"
	"database/sql"
	"testing"
)

// requestLogsWithoutTimingColumns is the request_logs shape from before the
// waterfall sample points existed, used to prove an upgraded database gains them
// and that its existing rows stay honest about never having been sampled.
const requestLogsWithoutTimingColumns = `
CREATE TABLE request_logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    method              TEXT NOT NULL,
    path                TEXT NOT NULL,
    downstream_token_id INTEGER,
    downstream_token_name TEXT,
    client_type         TEXT NOT NULL DEFAULT 'unknown',
    upstream_id         INTEGER,
    upstream_name       TEXT,
    model               TEXT,
    reasoning_effort    TEXT,
    response_reasoning_effort TEXT,
    stream              INTEGER NOT NULL DEFAULT 0,
    status_code         INTEGER,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    total_tokens        INTEGER,
    duration_ms         INTEGER,
    first_token_ms      INTEGER,
    error               TEXT
);`

// TestTimingColumnsMigrateOntoAnOlderDatabase covers the upgrade path: a
// database created before these columns existed must gain them, and the rows it
// already held must read as NULL rather than as zero. A zero would claim the
// upstream answered instantly, which is a stronger statement than "not sampled".
func TestTimingColumnsMigrateOntoAnOlderDatabase(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// memoryDB has already run Init, so the modern table is replaced with the
	// older shape before Init is asked to migrate it.
	if _, err := database.ExecContext(ctx, "DROP TABLE request_logs"); err != nil {
		t.Fatalf("drop table: %v", err)
	}
	if _, err := database.ExecContext(ctx, requestLogsWithoutTimingColumns); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO request_logs
	    (id, created_at, method, path, client_type, status_code, duration_ms)
	    VALUES (1, '2026-08-01 10:00:00', 'POST', '/v1/chat', 'codex', 200, 900)`); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	if err := Init(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	entries, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("read %d rows, want the migrated one", len(entries))
	}

	legacy := entries[0]
	if legacy.RequestUID != nil {
		t.Errorf("request_uid = %q on a pre-migration row, want nil", *legacy.RequestUID)
	}
	if legacy.AttemptIndex != nil {
		t.Errorf("attempt_index = %d on a pre-migration row, want nil", *legacy.AttemptIndex)
	}
	if legacy.PreUpstreamMs != nil {
		t.Errorf("pre_upstream_ms = %d on a pre-migration row, want nil", *legacy.PreUpstreamMs)
	}
	if legacy.UpstreamHeadersMs != nil {
		t.Errorf("upstream_headers_ms = %d on a pre-migration row, want nil",
			*legacy.UpstreamHeadersMs)
	}
	// The timings it did carry must survive the migration untouched.
	if legacy.DurationMs == nil || *legacy.DurationMs != 900 {
		t.Errorf("duration_ms = %v, want the original 900", legacy.DurationMs)
	}
}

// TestTimingSamplesRoundTripThroughBothReadPaths is the contract the console
// consumes: the list and the detail endpoint report the same sample points, so a
// waterfall opened from a row matches the row it was opened from.
func TestTimingSamplesRoundTripThroughBothReadPaths(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.ExecContext(ctx, `INSERT INTO request_logs
	    (id, created_at, method, path, client_type, stream, status_code,
	     duration_ms, first_token_ms, request_uid, attempt_index,
	     pre_upstream_ms, upstream_headers_ms)
	    VALUES (1, '2026-08-18 10:00:00', 'POST', '/v1/chat', 'codex', 1, 200,
	            5000, 1200, 'a1b2c3d4', 1, 45, 300)`); err != nil {
		t.Fatalf("insert row: %v", err)
	}
	// A row whose stages were never sampled, to prove NULL survives both paths
	// instead of arriving as zero.
	if _, err := database.ExecContext(ctx, `INSERT INTO request_logs
	    (id, created_at, method, path, client_type, stream, status_code, duration_ms)
	    VALUES (2, '2026-08-18 11:00:00', 'POST', '/v1/chat', 'codex', 0, 200, 80)`); err != nil {
		t.Fatalf("insert unsampled row: %v", err)
	}

	entries, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	byID := map[int64]int{}
	for index, entry := range entries {
		byID[entry.ID] = index
	}
	sampled := entries[byID[1]]

	if sampled.RequestUID == nil || *sampled.RequestUID != "a1b2c3d4" {
		t.Errorf("list request_uid = %v, want a1b2c3d4", sampled.RequestUID)
	}
	if sampled.AttemptIndex == nil || *sampled.AttemptIndex != 1 {
		t.Errorf("list attempt_index = %v, want 1", sampled.AttemptIndex)
	}
	if sampled.PreUpstreamMs == nil || *sampled.PreUpstreamMs != 45 {
		t.Errorf("list pre_upstream_ms = %v, want 45", sampled.PreUpstreamMs)
	}
	if sampled.UpstreamHeadersMs == nil || *sampled.UpstreamHeadersMs != 300 {
		t.Errorf("list upstream_headers_ms = %v, want 300", sampled.UpstreamHeadersMs)
	}

	detail, ok, err := GetLogDetail(ctx, database, 1)
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	if !ok {
		t.Fatal("detail not found")
	}
	if detail.PreUpstreamMs == nil || *detail.PreUpstreamMs != 45 {
		t.Errorf("detail pre_upstream_ms = %v, want 45", detail.PreUpstreamMs)
	}
	if detail.UpstreamHeadersMs == nil || *detail.UpstreamHeadersMs != 300 {
		t.Errorf("detail upstream_headers_ms = %v, want 300", detail.UpstreamHeadersMs)
	}
	if detail.RequestUID == nil || *detail.RequestUID != "a1b2c3d4" {
		t.Errorf("detail request_uid = %v, want a1b2c3d4", detail.RequestUID)
	}
	if detail.AttemptIndex == nil || *detail.AttemptIndex != 1 {
		t.Errorf("detail attempt_index = %v, want 1", detail.AttemptIndex)
	}

	// The waterfall's stages have to nest for the console to lay them out, which
	// only holds if all three attempt-relative fields share one origin.
	if *detail.UpstreamHeadersMs > *detail.FirstTokenMs ||
		*detail.FirstTokenMs > *detail.DurationMs {
		t.Errorf("stages do not nest: headers %d, first token %d, duration %d",
			*detail.UpstreamHeadersMs, *detail.FirstTokenMs, *detail.DurationMs)
	}

	unsampled := entries[byID[2]]
	if unsampled.UpstreamHeadersMs != nil || unsampled.PreUpstreamMs != nil ||
		unsampled.AttemptIndex != nil || unsampled.RequestUID != nil {
		t.Error("an unsampled row reported sample points through the list path")
	}
	unsampledDetail, ok, err := GetLogDetail(ctx, database, 2)
	if err != nil || !ok {
		t.Fatalf("get unsampled detail: %v ok=%v", err, ok)
	}
	if unsampledDetail.UpstreamHeadersMs != nil || unsampledDetail.PreUpstreamMs != nil ||
		unsampledDetail.AttemptIndex != nil || unsampledDetail.RequestUID != nil {
		t.Error("an unsampled row reported sample points through the detail path")
	}
}

// TestAttemptChainIsQueryableByRequestUID is what makes the correlation key
// worth storing: the rows one request produced can be collected in write order.
func TestAttemptChainIsQueryableByRequestUID(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	rows := []struct {
		id            int64
		uid           string
		attemptIndex  int32
		preUpstreamMs int32
		status        int32
	}{
		{1, "chain01", 0, 12, 502},
		{2, "chain01", 1, 1130, 200},
		{3, "other99", 0, 8, 200},
	}
	for _, row := range rows {
		if _, err := database.ExecContext(ctx, `INSERT INTO request_logs
		    (id, created_at, method, path, client_type, status_code,
		     request_uid, attempt_index, pre_upstream_ms)
		    VALUES (?, '2026-08-18 10:00:00', 'POST', '/v1/chat', 'codex', ?, ?, ?, ?)`,
			row.id, row.status, row.uid, row.attemptIndex, row.preUpstreamMs); err != nil {
			t.Fatalf("insert row %d: %v", row.id, err)
		}
	}

	queried, err := database.QueryContext(ctx, `SELECT id, attempt_index, pre_upstream_ms
	    FROM request_logs WHERE request_uid = ? ORDER BY attempt_index`, "chain01")
	if err != nil {
		t.Fatalf("query chain: %v", err)
	}
	defer queried.Close()

	var collected []int64
	var lastPreUpstream int64 = -1
	for queried.Next() {
		var id, attemptIndex, preUpstreamMs sql.NullInt64
		if err := queried.Scan(&id, &attemptIndex, &preUpstreamMs); err != nil {
			t.Fatalf("scan: %v", err)
		}
		collected = append(collected, id.Int64)
		// A later attempt's pre-upstream figure includes the attempts before it,
		// so the sequence cannot decrease. This is the property that makes the
		// field readable only alongside attempt_index.
		if preUpstreamMs.Int64 < lastPreUpstream {
			t.Errorf("attempt %d reports %dms, below the previous %dms",
				attemptIndex.Int64, preUpstreamMs.Int64, lastPreUpstream)
		}
		lastPreUpstream = preUpstreamMs.Int64
	}
	if err := queried.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	if len(collected) != 2 {
		t.Fatalf("collected %d rows for the chain, want 2", len(collected))
	}
	if collected[0] != 1 || collected[1] != 2 {
		t.Errorf("chain = %v, want [1 2] and no rows from the other request", collected)
	}
}
