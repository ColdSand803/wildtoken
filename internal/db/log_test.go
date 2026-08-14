package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func itoa(value int) string { return strconv.Itoa(value) }

func nowUnix() int64 { return time.Now().UTC().Unix() }

func nullString(value string) sql.NullString {
	return sql.NullString{String: value, Valid: true}
}

func nullStringInvalid() sql.NullString { return sql.NullString{} }

func logIDs(entries []models.RequestLogOut) []int64 {
	ids := make([]int64, 0, len(entries))
	for _, entry := range entries {
		ids = append(ids, entry.ID)
	}
	return ids
}

func TestListLogsPaginatesByCursorAndAppliesFilters(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// request_logs references upstreams, so the channel has to exist first.
	if _, err := database.Exec(`INSERT INTO upstreams (id, name, base_url)
        VALUES (1, 'primary', 'https://example.test')`); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}

	for i := 1; i <= 5; i++ {
		status := 200
		if i == 3 {
			status = 500
		}
		// Only one row carries a token name, so a search for it has to narrow
		// rather than match everything the way the shared model name does.
		tokenName := "customer-a"
		if i != 2 {
			tokenName = "customer-b"
		}
		_, err := database.Exec(`INSERT INTO request_logs
            (id, created_at, method, path, client_type, upstream_id, upstream_name,
             downstream_token_name, model, stream, status_code, total_tokens)
            VALUES (?, datetime('now', ?), 'POST', '/v1/responses', 'codex',
                    1, 'primary', ?, 'gpt-test', 0, ?, 10)`,
			i, "-"+itoa(5-i)+" minutes", tokenName, status)
		if err != nil {
			t.Fatalf("insert log %d: %v", i, err)
		}
	}

	page, err := ListLogs(ctx, database, 2, 0, nil, LogFilter{})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(page) != 2 || page[0].ID != 5 || page[1].ID != 4 {
		t.Fatalf("first page = %v, want the two newest rows", logIDs(page))
	}

	cursor := &LogCursor{CreatedAt: page[1].CreatedAt, ID: page[1].ID}
	next, err := ListLogs(ctx, database, 2, 0, cursor, LogFilter{})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(next) != 2 || next[0].ID != 3 || next[1].ID != 2 {
		t.Fatalf("second page = %v, want rows 3 and 2", logIDs(next))
	}

	status := "5xx"
	failures, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{Status: &status})
	if err != nil {
		t.Fatalf("status filter: %v", err)
	}
	if len(failures) != 1 || failures[0].ID != 3 {
		t.Errorf("status filter = %v, want only the 5xx row", logIDs(failures))
	}

	search := "gpt-test"
	matches, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{Search: &search})
	if err != nil {
		t.Fatalf("search filter: %v", err)
	}
	if len(matches) != 5 {
		t.Errorf("search matched %d rows, want all 5", len(matches))
	}

	tokenSearch := "customer-a"
	byToken, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{Search: &tokenSearch})
	if err != nil {
		t.Fatalf("token name search: %v", err)
	}
	if len(byToken) != 1 || byToken[0].ID != 2 {
		t.Errorf("token name search = %v, want only row 2", logIDs(byToken))
	}

	// A search for a literal wildcard must not match every row.
	wildcard := "%"
	none, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{Search: &wildcard})
	if err != nil {
		t.Fatalf("wildcard search: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("a literal %% matched %d rows, want 0", len(none))
	}
}

func TestGetLogDetailResolvesOverridesAgainstCanonicalSnapshots(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO request_logs
        (id, method, path, client_type, stream) VALUES (1, 'POST', '/v1/responses', 'codex', 0)`); err != nil {
		t.Fatalf("insert log: %v", err)
	}
	// The upstream request matched the downstream one; the downstream response
	// was explicitly absent.
	if _, err := database.Exec(`INSERT INTO request_log_payloads
        (request_log_id, request_snapshot, upstream_request_override, upstream_request_is_override,
         response_snapshot, downstream_response_override, downstream_response_is_override)
        VALUES (1, '{"body":{"text":"req"}}', NULL, 0, '{"body":{"text":"res"}}', NULL, 1)`); err != nil {
		t.Fatalf("insert payload: %v", err)
	}

	detail, ok, err := GetLogDetail(ctx, database, 1)
	if err != nil || !ok {
		t.Fatalf("get detail: %v (ok=%v)", err, ok)
	}
	if string(detail.DownstreamRequest) != `{"body":{"text":"req"}}` {
		t.Errorf("downstream request = %s", detail.DownstreamRequest)
	}
	// A cleared override flag means the peer was identical, so the canonical
	// snapshot is what the console sees.
	if string(detail.UpstreamRequest) != `{"body":{"text":"req"}}` {
		t.Errorf("upstream request = %s, want the canonical snapshot", detail.UpstreamRequest)
	}
	if string(detail.UpstreamResponse) != `{"body":{"text":"res"}}` {
		t.Errorf("upstream response = %s", detail.UpstreamResponse)
	}
	// A set override flag with a null value means the peer was absent.
	if detail.DownstreamResponse != nil {
		t.Errorf("downstream response = %s, want nil", detail.DownstreamResponse)
	}

	if _, ok, err := GetLogDetail(ctx, database, 404); err != nil || ok {
		t.Errorf("missing log: ok=%v err=%v", ok, err)
	}
}

func TestTopLogStatsRanksModelsAndChannels(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	for id, name := range map[int]string{1: "primary", 2: "secondary"} {
		if _, err := database.Exec(`INSERT INTO upstreams (id, name, base_url)
            VALUES (?, ?, 'https://example.test')`, id, name); err != nil {
			t.Fatalf("insert upstream %d: %v", id, err)
		}
	}

	rows := []struct {
		id            int
		upstreamID    int
		upstreamName  string
		upstreamModel string
		totalTokens   int
	}{
		{1, 1, "primary", "gpt-test", 100},
		{2, 1, "primary", "gpt-test", 200},
		{3, 2, "secondary", "claude-test", 50},
		{4, 2, "secondary", "gpt-test", 10},
	}
	for _, row := range rows {
		_, err := database.Exec(`INSERT INTO request_logs
            (id, method, path, client_type, upstream_id, upstream_name, upstream_model,
             stream, status_code, total_tokens)
            VALUES (?, 'POST', '/v1/responses', 'codex', ?, ?, ?, 0, 200, ?)`,
			row.id, row.upstreamID, row.upstreamName, row.upstreamModel, row.totalTokens)
		if err != nil {
			t.Fatalf("insert log %d: %v", row.id, err)
		}
	}

	stats, err := TopLogStats(ctx, database, LogTopWindowSevenDays, 10)
	if err != nil {
		t.Fatalf("top stats: %v", err)
	}
	if stats.Window != "7d" {
		t.Errorf("window = %q, want 7d", stats.Window)
	}
	if len(stats.Models) != 2 || stats.Models[0].Name != "gpt-test" || stats.Models[0].Count != 3 {
		t.Errorf("model ranking = %+v, want gpt-test first with 3", stats.Models)
	}
	if len(stats.Channels) != 2 || stats.Channels[0].Name != "primary" || stats.Channels[0].Count != 2 {
		t.Errorf("channel ranking = %+v, want primary first with 2", stats.Channels)
	}
	// Channel rankings expose the numeric group key so the console can link.
	if stats.Channels[0].ID == nil || *stats.Channels[0].ID != 1 {
		t.Errorf("channel id = %v, want 1", stats.Channels[0].ID)
	}
	if stats.Models[0].ID != nil {
		t.Errorf("model ranking exposed an id: %v", stats.Models[0].ID)
	}
	if len(stats.ModelTokens) == 0 || stats.ModelTokens[0].Count != 310 {
		t.Errorf("model token ranking = %+v, want gpt-test with 310", stats.ModelTokens)
	}
	if len(stats.ChannelTokens) == 0 || stats.ChannelTokens[0].Count != 300 {
		t.Errorf("channel token ranking = %+v, want primary with 300", stats.ChannelTokens)
	}

	// The limit is clamped into 1..=20.
	clamped, err := TopLogStats(ctx, database, LogTopWindowSevenDays, 0)
	if err != nil {
		t.Fatalf("clamped stats: %v", err)
	}
	if len(clamped.Models) != 1 {
		t.Errorf("a zero limit returned %d models, want it clamped to 1", len(clamped.Models))
	}
}

func TestDeleteOldLogsRemovesPayloadsWithTheirLogs(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	for i, age := range []string{"-40 days", "-1 days"} {
		id := i + 1
		if _, err := database.Exec(`INSERT INTO request_logs
            (id, created_at, method, path, client_type, stream)
            VALUES (?, datetime('now', ?), 'POST', '/v1/responses', 'codex', 0)`,
			id, age); err != nil {
			t.Fatalf("insert log: %v", err)
		}
		if _, err := database.Exec(`INSERT INTO request_log_payloads
            (request_log_id, request_snapshot) VALUES (?, '{"body":{"text":"x"}}')`,
			id); err != nil {
			t.Fatalf("insert payload: %v", err)
		}
	}

	if err := DeleteOldLogs(ctx, database, 30); err != nil {
		t.Fatalf("delete: %v", err)
	}

	var logCount, payloadCount int64
	if err := database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&logCount); err != nil {
		t.Fatalf("count logs: %v", err)
	}
	if err := database.QueryRow("SELECT COUNT(*) FROM request_log_payloads").
		Scan(&payloadCount); err != nil {
		t.Fatalf("count payloads: %v", err)
	}
	if logCount != 1 || payloadCount != 1 {
		t.Errorf("after retention: %d logs, %d payloads, want 1 and 1", logCount, payloadCount)
	}
}

func TestClearSnapshotBodyKeepsMetadataAndSurvivesCorruptJSON(t *testing.T) {
	stored := nullString(`{"method":"POST","body":{"text":"secret"}}`)
	cleared, ok := clearSnapshotBody(stored, true).(string)
	if !ok {
		t.Fatalf("clearSnapshotBody returned %T, want a string", clearSnapshotBody(stored, true))
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal([]byte(cleared), &decoded); err != nil {
		t.Fatalf("decode cleared: %v", err)
	}
	if string(decoded["method"]) != `"POST"` {
		t.Errorf("metadata was lost: %s", cleared)
	}
	if string(decoded["body"]) != `{"cleared":true}` {
		t.Errorf("body = %s, want it cleared", decoded["body"])
	}

	// A snapshot that no longer parses is replaced wholesale rather than kept.
	corrupt := clearSnapshotBody(nullString("not json"), true)
	if corrupt != clearedBodySnapshot {
		t.Errorf("corrupt snapshot = %v, want the cleared placeholder", corrupt)
	}

	// Nothing is rewritten when the row is not due for clearing.
	untouched := clearSnapshotBody(stored, false)
	if untouched != stored.String {
		t.Errorf("snapshot = %v, want it untouched", untouched)
	}

	if clearSnapshotBody(nullStringInvalid(), true) != nil {
		t.Error("an absent snapshot produced a value")
	}
}

func TestRefreshGroupsLogsIntoUsageWindows(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO request_logs
       (id, created_at, method, path, client_type, stream, prompt_tokens,
        prompt_cached_tokens, total_tokens) VALUES
       (1, datetime('now'), 'POST', '/v1/responses', 'codex', 0, 80, 20, 100),
       (2, datetime('now'), 'POST', '/v1/responses', 'codex', 0, NULL, NULL, NULL),
       (3, datetime('now', '-2 days'), 'POST', '/v1/responses', 'codex', 0, 120, 30, 200),
       (4, datetime('now', '-8 days'), 'POST', '/v1/responses', 'codex', 0, NULL, NULL, NULL),
       (5, datetime('now', '-31 days'), 'POST', '/v1/responses', 'codex', 0, 200, 50, 400)`); err != nil {
		t.Fatalf("insert logs: %v", err)
	}

	cache, err := LoadLogStatsCache(ctx, database)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	snapshot := cache.Snapshot()

	if snapshot.TotalLogCount != 5 {
		t.Errorf("total = %d, want 5", snapshot.TotalLogCount)
	}
	if snapshot.LogCount24h != 2 {
		t.Errorf("24h = %d, want 2", snapshot.LogCount24h)
	}
	// The 8-day-old row is outside seven days but inside thirty, and the
	// 31-day-old row falls out of the window entirely.
	sevenDays := snapshot.TokenUsage.SevenDays
	if sevenDays.TotalTokens != 300 || sevenDays.PromptTokens != 200 ||
		sevenDays.PromptCachedTokens != 50 || sevenDays.RequestCount != 2 ||
		sevenDays.AllRequestCount != 3 {
		t.Errorf("seven-day window = %+v", sevenDays)
	}
	thirtyDays := snapshot.TokenUsage.ThirtyDays
	if thirtyDays.TotalTokens != 300 || thirtyDays.AllRequestCount != 4 {
		t.Errorf("thirty-day window = %+v", thirtyDays)
	}
}

func TestRecordPersistedEntriesUpdatesCacheWithoutRefresh(t *testing.T) {
	cache := NewLogStatsCache()
	now := nowUnix()
	total, prompt, cached := int64(12), int64(9), int64(3)

	cache.RecordPersistedEntries([]PersistedLogStats{
		{ID: 1, CreatedAtUnixSeconds: now, TotalTokens: &total,
			PromptTokens: &prompt, PromptCachedTokens: &cached},
		{ID: 2, CreatedAtUnixSeconds: now},
	})

	snapshot := cache.Snapshot()
	if snapshot.TotalLogCount != 2 || snapshot.LogCount24h != 2 {
		t.Errorf("counts = %d total / %d in 24h, want 2/2",
			snapshot.TotalLogCount, snapshot.LogCount24h)
	}
	window := snapshot.TokenUsage.ThirtyDays
	if window.TotalTokens != 12 || window.PromptTokens != 9 ||
		window.PromptCachedTokens != 3 || window.RequestCount != 1 ||
		window.AllRequestCount != 2 {
		t.Errorf("window = %+v", window)
	}

	// A replayed entry must not be counted twice.
	cache.RecordPersistedEntries([]PersistedLogStats{{ID: 1, CreatedAtUnixSeconds: now,
		TotalTokens: &total, PromptTokens: &prompt, PromptCachedTokens: &cached}})
	if replayed := cache.Snapshot(); replayed.TotalLogCount != 2 {
		t.Errorf("total after replay = %d, want 2", replayed.TotalLogCount)
	}
}

func TestRecentOneMinuteRateCountsOnlySuccessfulRequests(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO request_logs
       (id, created_at, method, path, client_type, stream, status_code, total_tokens) VALUES
       (1, datetime('now'), 'POST', '/v1/r', 'codex', 0, 200, 10),
       (2, datetime('now', '-30 seconds'), 'POST', '/v1/r', 'codex', 0, 204, 20),
       (3, datetime('now', '-5 seconds'), 'POST', '/v1/r', 'codex', 0, 500, 99),
       (4, datetime('now', '-10 seconds'), 'POST', '/v1/r', 'codex', 0, 404, NULL),
       (5, datetime('now', '-15 seconds'), 'POST', '/v1/r', 'codex', 0, NULL, 7),
       (6, datetime('now', '-90 seconds'), 'POST', '/v1/r', 'codex', 0, 200, 30)`); err != nil {
		t.Fatalf("insert logs: %v", err)
	}

	count, err := RecentOneMinuteLogCount(ctx, database)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want only the two 2xx rows inside the window", count)
	}

	rate, err := RecentOneMinuteLogRate(ctx, database)
	if err != nil {
		t.Fatalf("rate: %v", err)
	}
	if rate.RequestCount != 2 || rate.TotalTokens != 30 {
		t.Errorf("rate = %+v, want 2 requests and 30 tokens", rate)
	}
}

func TestRefreshPreservesPendingEntriesNewerThanTheWatermark(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO request_logs
        (id, created_at, method, path, client_type, stream, total_tokens)
        VALUES (1, datetime('now'), 'POST', '/v1/r', 'codex', 0, 10)`); err != nil {
		t.Fatalf("insert: %v", err)
	}

	cache := NewLogStatsCache()
	total, prompt, cached := int64(5), int64(4), int64(1)
	cache.RecordPersistedEntries([]PersistedLogStats{{
		ID: 2, CreatedAtUnixSeconds: nowUnix(),
		TotalTokens: &total, PromptTokens: &prompt, PromptCachedTokens: &cached,
	}})
	if err := cache.RefreshFromDB(ctx, database); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	// Row 2 committed after the refresh read the table, so its counts are carried
	// over rather than lost.
	snapshot := cache.Snapshot()
	if snapshot.TotalLogCount != 2 {
		t.Errorf("total = %d, want 2", snapshot.TotalLogCount)
	}
	window := snapshot.TokenUsage.ThirtyDays
	if window.TotalTokens != 15 || window.PromptTokens != 4 ||
		window.PromptCachedTokens != 1 || window.RequestCount != 2 {
		t.Errorf("window = %+v, want the pending entry merged in", window)
	}
}

func TestPendingEntriesAreBoundedWhenRefreshesStopHappening(t *testing.T) {
	cache := NewLogStatsCache()
	now := nowUnix()

	// Every committed row is held until the next successful rebuild carries it
	// across. Nothing trimmed the map, so a database that stopped answering
	// turned steady traffic into unbounded memory.
	surplus := 1000
	entries := make([]PersistedLogStats, 0, maxPendingEntries+surplus)
	for id := range int64(maxPendingEntries + surplus) {
		entries = append(entries, PersistedLogStats{ID: id + 1, CreatedAtUnixSeconds: now})
	}
	cache.RecordPersistedEntries(entries)

	// Snapshot prunes, which is where the cap applies.
	snapshot := cache.Snapshot()

	cache.mu.Lock()
	held := len(cache.state.pendingEntries)
	cache.mu.Unlock()

	if held > maxPendingEntries {
		t.Errorf("held %d pending entries, want at most %d", held, maxPendingEntries)
	}
	// The counts the dropped entries contributed stay in the buckets; only the
	// ability to replay them across a rebuild is given up.
	if snapshot.TotalLogCount != int64(maxPendingEntries+surplus) {
		t.Errorf("total = %d, want every entry counted once", snapshot.TotalLogCount)
	}
}

func TestStaleWindowEntriesLeaveThePendingMap(t *testing.T) {
	cache := NewLogStatsCache()
	now := nowUnix()

	cache.RecordPersistedEntries([]PersistedLogStats{
		{ID: 1, CreatedAtUnixSeconds: now},
		// Outside the thirty-day window, so it can never reach a bucket again.
		{ID: 2, CreatedAtUnixSeconds: now - int64((31 * 24 * time.Hour).Seconds())},
	})
	cache.Snapshot()

	cache.mu.Lock()
	_, staleHeld := cache.state.pendingEntries[2]
	_, freshHeld := cache.state.pendingEntries[1]
	cache.mu.Unlock()

	if staleHeld {
		t.Error("an entry outside the window is still held for replay")
	}
	if !freshHeld {
		t.Error("an entry inside the window was dropped")
	}
}
