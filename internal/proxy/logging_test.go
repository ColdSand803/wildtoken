package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/quota"
)

func decodeSnapshotMap(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	return decoded
}

func TestRequestAndResponseSnapshotsRedactMixedCaseSensitiveHeaders(t *testing.T) {
	headers := map[string]string{
		"aUtHoRiZaTiOn":       "Bearer secret",
		"sEt-CoOkIe":          "session=secret",
		"Api-Key":             "api-secret",
		"X-aCcEsS-tOkEn":      "access-secret",
		"X-Custom-Secret":     "custom-secret",
		"PrOxY-aUtHoRiZaTiOn": "proxy-secret",
		"X-Request-Id":        "request-123",
	}

	for _, snapshot := range []json.RawMessage{
		SnapshotRequest("GET", "https://example.test", headers, nil, 1024),
		SnapshotResponse(200, headers, nil, 1024),
	} {
		decoded := decodeSnapshotMap(t, snapshot)
		snapshotHeaders, ok := decoded["headers"].(map[string]any)
		if !ok {
			t.Fatalf("headers missing from snapshot: %s", snapshot)
		}
		for _, name := range []string{"aUtHoRiZaTiOn", "sEt-CoOkIe", "Api-Key",
			"X-aCcEsS-tOkEn", "X-Custom-Secret", "PrOxY-aUtHoRiZaTiOn"} {
			if snapshotHeaders[name] != "***REDACTED***" {
				t.Errorf("header %s = %v, want it redacted", name, snapshotHeaders[name])
			}
		}
		if snapshotHeaders["X-Request-Id"] != "request-123" {
			t.Errorf("a non-sensitive header was redacted: %v", snapshotHeaders["X-Request-Id"])
		}
	}
}

func TestTextIsTruncatedAtUTF8Boundary(t *testing.T) {
	body := truncateBody([]byte("aéz"), 2)
	if body["text"] != "a" {
		t.Errorf("text = %v, want the prefix cut back to a rune boundary", body["text"])
	}
	if body["byte_length"] != 4 {
		t.Errorf("byte_length = %v, want 4", body["byte_length"])
	}
	if body["truncated"] != true {
		t.Error("truncated was not reported")
	}
}

func TestBinaryIsSlicedBeforeBase64Encoding(t *testing.T) {
	body := truncateBody([]byte{0xff, 1, 2, 3}, 2)
	if body["base64"] != "/wE=" {
		t.Errorf("base64 = %v, want /wE=", body["base64"])
	}
	if body["byte_length"] != 4 {
		t.Errorf("byte_length = %v, want 4", body["byte_length"])
	}
	if body["truncated"] != true {
		t.Error("truncated was not reported")
	}

	// The whole body is present and is not valid text, so it is encoded as
	// binary even though the budget cuts before the invalid byte.
	invalidAfterBudget := truncateBody([]byte{'a', 0xff}, 1)
	if invalidAfterBudget["base64"] != "YQ==" {
		t.Errorf("base64 = %v, want YQ==", invalidAfterBudget["base64"])
	}
	if invalidAfterBudget["byte_length"] != 2 {
		t.Errorf("byte_length = %v, want 2", invalidAfterBudget["byte_length"])
	}
}

func TestZeroBudgetClearsBodyOnly(t *testing.T) {
	body := truncateBody([]byte("body"), 0)
	if body["cleared"] != true || body["byte_length"] != 4 {
		t.Errorf("body = %v, want it cleared with the original length", body)
	}
	if _, hasText := body["text"]; hasText {
		t.Error("a cleared body still carried text")
	}
}

func TestBoundedResponseSnapshotRetainsTheOriginalByteLength(t *testing.T) {
	snapshot := SnapshotResponseWithBodyLength(200, map[string]string{},
		[]byte("aé"), 100, 2)
	decoded := decodeSnapshotMap(t, snapshot)
	body, ok := decoded["body"].(map[string]any)
	if !ok {
		t.Fatalf("body missing from snapshot: %s", snapshot)
	}
	if body["text"] != "a" {
		t.Errorf("text = %v, want the prefix cut at a rune boundary", body["text"])
	}
	if body["byte_length"] != float64(100) {
		t.Errorf("byte_length = %v, want the original 100", body["byte_length"])
	}
	if body["truncated"] != true {
		t.Error("truncated was not reported")
	}
}

func TestSnapshotPairDistinguishesSameFromExplicitlyMissingOverride(t *testing.T) {
	snapshot := json.RawMessage(`{"body":{"text":"hello"}}`)

	same := encodeSnapshotPair(snapshot, snapshot)
	if same.canonical != string(snapshot) {
		t.Errorf("canonical = %v, want the snapshot", same.canonical)
	}
	if same.isOverride {
		t.Error("identical snapshots were recorded as an override")
	}
	if same.overrideValue != nil {
		t.Errorf("override value = %v, want nil", same.overrideValue)
	}

	missing := encodeSnapshotPair(snapshot, nil)
	if !missing.isOverride {
		t.Error("an absent peer was not recorded as an override")
	}
	if missing.overrideValue != nil {
		t.Errorf("override value = %v, want nil for an absent peer", missing.overrideValue)
	}

	bothMissing := encodeSnapshotPair(nil, nil)
	if bothMissing.isOverride || bothMissing.canonical != nil || bothMissing.overrideValue != nil {
		t.Errorf("two absent snapshots = %+v, want an empty pair", bothMissing)
	}
}

func loggingTestDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+t.Name()+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { database.Close() })
	if err := db.Init(context.Background(), database); err != nil {
		t.Fatalf("init: %v", err)
	}
	return database
}

func TestLogInsertWritesMetadataAndDeduplicatedPayloadAtomically(t *testing.T) {
	database := loggingTestDB(t)
	request := json.RawMessage(`{"body":{"text":"request"}}`)
	response := json.RawMessage(`{"body":{"text":"response"}}`)
	promptCached, cacheCreation, reasoning := int32(12), int32(34), int32(56)

	records, err := insertLogBatch(context.Background(), database, []LogEntry{{
		Method:                    "POST",
		Path:                      "/v1/responses",
		DownstreamRequest:         request,
		UpstreamRequest:           request,
		UpstreamResponse:          response,
		PromptCachedTokens:        &promptCached,
		CacheCreationTokens:       &cacheCreation,
		CompletionReasoningTokens: &reasoning,
	}})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("inserted %d records, want 1", len(records))
	}

	var requestSnapshot, upstreamOverride, responseSnapshot, downstreamOverride sql.NullString
	var upstreamIsOverride, downstreamIsOverride int64
	err = database.QueryRow(`SELECT request_snapshot, upstream_request_override,
                  upstream_request_is_override, response_snapshot,
                  downstream_response_override, downstream_response_is_override
           FROM request_log_payloads WHERE request_log_id = 1`).
		Scan(&requestSnapshot, &upstreamOverride, &upstreamIsOverride,
			&responseSnapshot, &downstreamOverride, &downstreamIsOverride)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}

	// An identical upstream request is stored once, with the override cleared.
	if requestSnapshot.String != string(request) || upstreamOverride.Valid || upstreamIsOverride != 0 {
		t.Errorf("request payload was not deduplicated: %v %v %d",
			requestSnapshot, upstreamOverride, upstreamIsOverride)
	}
	// An absent downstream response is an override with a null value.
	if responseSnapshot.String != string(response) || downstreamOverride.Valid || downstreamIsOverride != 1 {
		t.Errorf("response payload = %v %v %d, want an explicit missing override",
			responseSnapshot, downstreamOverride, downstreamIsOverride)
	}

	var storedCached, storedCreation, storedReasoning sql.NullInt64
	err = database.QueryRow(`SELECT prompt_cached_tokens, cache_creation_tokens,
              completion_reasoning_tokens FROM request_logs WHERE id = 1`).
		Scan(&storedCached, &storedCreation, &storedReasoning)
	if err != nil {
		t.Fatalf("read token details: %v", err)
	}
	if storedCached.Int64 != 12 || storedCreation.Int64 != 34 || storedReasoning.Int64 != 56 {
		t.Errorf("token details = %d/%d/%d, want 12/34/56",
			storedCached.Int64, storedCreation.Int64, storedReasoning.Int64)
	}
}

func TestLogWriterBatchesQueuedEntriesAndUpdatesMetrics(t *testing.T) {
	database := loggingTestDB(t)
	runtimeMetrics := metrics.New()
	logStats := db.NewLogStatsCache()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := NewLogWriter(ctx, database, runtimeMetrics, logStats, 16, quota.NewTracker(), NewPricingBook(), nil)
	events, unsubscribe := writer.Subscribe()
	defer unsubscribe()

	status := int32(200)
	for _, path := range []string{"/v1/responses", "/v1/chat/completions"} {
		writer.Schedule(LogEntry{Method: "POST", Path: path, StatusCode: &status})
	}
	writer.Close()

	var count int64
	if err := database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
		t.Fatalf("count logs: %v", err)
	}
	if count != 2 {
		t.Fatalf("wrote %d logs, want 2", count)
	}

	var payloadCount int64
	if err := database.QueryRow("SELECT COUNT(*) FROM request_log_payloads").
		Scan(&payloadCount); err != nil {
		t.Fatalf("count payloads: %v", err)
	}
	if payloadCount != 2 {
		t.Errorf("wrote %d payloads, want 2", payloadCount)
	}

	snapshot := runtimeMetrics.Snapshot()
	if snapshot.LogQueueDepth != 0 {
		t.Errorf("queue depth = %d, want 0", snapshot.LogQueueDepth)
	}
	if snapshot.LogWrittenTotal != 2 {
		t.Errorf("written total = %d, want 2", snapshot.LogWrittenTotal)
	}
	// Both entries land in one batch, because the second arrives inside the
	// collection window.
	if snapshot.LogWriteBatchesTotal != 1 {
		t.Errorf("batches = %d, want 1", snapshot.LogWriteBatchesTotal)
	}
	if snapshot.LogDroppedTotal != 0 || snapshot.LogWriteFailuresTotal != 0 {
		t.Errorf("dropped=%d failures=%d, want none",
			snapshot.LogDroppedTotal, snapshot.LogWriteFailuresTotal)
	}

	statsSnapshot := logStats.Snapshot()
	if statsSnapshot.TotalLogCount != 2 || statsSnapshot.LogCount24h != 2 {
		t.Errorf("stats = %d total / %d in 24h, want 2/2",
			statsSnapshot.TotalLogCount, statsSnapshot.LogCount24h)
	}

	received := make([]LogStreamEvent, 0, 2)
	for range 2 {
		select {
		case event := <-events:
			received = append(received, event)
		case <-time.After(time.Second):
			t.Fatalf("only received %d events", len(received))
		}
	}
	if received[0].Log.ID != 1 || received[1].Log.ID != 2 {
		t.Errorf("event ids = %d, %d, want 1, 2", received[0].Log.ID, received[1].Log.ID)
	}
	if received[0].Log.Method != "POST" || received[0].Log.Path != "/v1/responses" {
		t.Errorf("first event = %+v, want the first scheduled entry", received[0].Log)
	}
	if received[0].RecentRPM == nil || *received[0].RecentRPM != 2 {
		t.Errorf("recent rpm = %v, want 2", received[0].RecentRPM)
	}
	if received[0].RecentTPM == nil || *received[0].RecentTPM != 0 {
		t.Errorf("recent tpm = %v, want 0", received[0].RecentTPM)
	}
}

func TestLogWriterDropsEntriesRatherThanBlockingWhenTheQueueIsFull(t *testing.T) {
	database := loggingTestDB(t)
	runtimeMetrics := metrics.New()

	// A zero capacity is raised to one, so exactly one entry can be queued while
	// the writer is busy.
	ctx, cancel := context.WithCancel(context.Background())
	writer := NewLogWriter(ctx, database, runtimeMetrics, db.NewLogStatsCache(), 1, quota.NewTracker(), NewPricingBook(), nil)

	// Stop the writer before scheduling, so nothing drains the queue.
	cancel()
	for range 64 {
		writer.Schedule(LogEntry{Method: "POST", Path: "/v1/responses"})
	}

	if dropped := runtimeMetrics.Snapshot().LogDroppedTotal; dropped == 0 {
		t.Error("a full queue did not drop any entry")
	}
}

func TestCleanupPassClearsBodiesBeyondTheKeepCount(t *testing.T) {
	database := loggingTestDB(t)
	ctx := context.Background()

	for range 5 {
		if _, err := insertLogBatch(ctx, database, []LogEntry{{
			Method:            "POST",
			Path:              "/v1/responses",
			DownstreamRequest: json.RawMessage(`{"body":{"text":"request"}}`),
			UpstreamResponse:  json.RawMessage(`{"body":{"text":"response"}}`),
		}}); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	settings := models.DefaultRuntimeSettings()
	settings.LogBodyKeepCount = 2
	runtimeMetrics := metrics.New()
	RunCleanupPass(ctx, database, &settings, runtimeMetrics, db.NewLogStatsCache(), false)

	var cleared int64
	if err := database.QueryRow(
		"SELECT COUNT(*) FROM request_log_payloads WHERE bodies_cleared = 1").
		Scan(&cleared); err != nil {
		t.Fatalf("count cleared: %v", err)
	}
	if cleared != 3 {
		t.Errorf("cleared %d payloads, want the 3 beyond the keep count", cleared)
	}

	// The newest rows keep their bodies.
	var retained sql.NullString
	if err := database.QueryRow(
		"SELECT request_snapshot FROM request_log_payloads WHERE request_log_id = 5").
		Scan(&retained); err != nil {
		t.Fatalf("read retained: %v", err)
	}
	if retained.String != `{"body":{"text":"request"}}` {
		t.Errorf("the newest payload was cleared: %v", retained.String)
	}

	// A cleared row keeps its metadata but loses the body.
	var clearedSnapshot sql.NullString
	if err := database.QueryRow(
		"SELECT request_snapshot FROM request_log_payloads WHERE request_log_id = 1").
		Scan(&clearedSnapshot); err != nil {
		t.Fatalf("read cleared: %v", err)
	}
	decoded := decodeSnapshotMap(t, json.RawMessage(clearedSnapshot.String))
	body, ok := decoded["body"].(map[string]any)
	if !ok || body["cleared"] != true {
		t.Errorf("cleared snapshot = %v, want its body replaced", clearedSnapshot.String)
	}

	if snapshot := runtimeMetrics.Snapshot(); snapshot.CleanupRunsTotal != 1 ||
		snapshot.CleanupLastRowsCleared != 3 || snapshot.CleanupActive {
		t.Errorf("cleanup metrics = %+v, want one finished run clearing 3 rows", snapshot)
	}
}

func TestCommittedLogsAdvanceTheTokenQuotaCounter(t *testing.T) {
	database := loggingTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "quota-client", Enabled: true, LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	total := int32(1500)
	entry := LogEntry{
		Method: "POST", Path: "/v1/responses",
		DownstreamTokenID: &created.ID,
		TotalTokens:       &total,
	}
	if _, err := insertLogBatch(ctx, database, []LogEntry{entry, entry}); err != nil {
		t.Fatalf("insert: %v", err)
	}

	// The counter advances in the same transaction as the log row, so two
	// committed requests are counted exactly once each.
	reloaded, _, err := db.GetToken(ctx, database, created.ID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Quota.UsedTokens != 3000 {
		t.Errorf("used = %d, want 3000", reloaded.Quota.UsedTokens)
	}
}

func TestARequestWithoutUsageLeavesTheQuotaUntouched(t *testing.T) {
	database := loggingTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "quota-client", Enabled: true, LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	// A failed request reports no usage, so it must not consume budget.
	message := "upstream unreachable"
	status := int32(502)
	if _, err := insertLogBatch(ctx, database, []LogEntry{{
		Method: "POST", Path: "/v1/responses",
		DownstreamTokenID: &created.ID,
		StatusCode:        &status,
		Error:             &message,
	}}); err != nil {
		t.Fatalf("insert: %v", err)
	}

	reloaded, _, err := db.GetToken(ctx, database, created.ID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Quota.UsedTokens != 0 {
		t.Errorf("used = %d, want 0 for a request with no usage", reloaded.Quota.UsedTokens)
	}
}

func TestSchedulingAfterCloseDropsTheEntryRatherThanPanicking(t *testing.T) {
	database := loggingTestDB(t)
	runtimeMetrics := metrics.New()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := NewLogWriter(ctx, database, runtimeMetrics, db.NewLogStatsCache(), 8, quota.NewTracker(), NewPricingBook(), nil)
	writer.Close()

	// A stream still running when the server stopped waiting for it schedules
	// its log after shutdown has closed the queue. Sending on a closed channel
	// panics, and the select's default case does not prevent that.
	writer.Schedule(LogEntry{Method: "POST", Path: "/v1/responses"})

	if dropped := runtimeMetrics.Snapshot().LogDroppedTotal; dropped != 1 {
		t.Errorf("dropped = %d, want the entry to be dropped once", dropped)
	}
}

func TestSchedulingConcurrentlyWithCloseNeverPanics(t *testing.T) {
	database := loggingTestDB(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := NewLogWriter(ctx, database, metrics.New(), db.NewLogStatsCache(), 8, quota.NewTracker(), NewPricingBook(), nil)

	// Close races the schedulers rather than following them, which is the order
	// a shutdown that timed out on its in-flight requests produces.
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			for range 32 {
				writer.Schedule(LogEntry{Method: "POST", Path: "/v1/responses"})
			}
		})
	}
	wg.Go(writer.Close)
	wg.Wait()
}
