package db

import (
	"context"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func int32Ptr(value int32) *int32 { return &value }

func int64Ptr(value int64) *int64 { return &value }

func stringPtr(value string) *string { return &value }

// TestLogFilterMatchesAgreesWithSQL runs the same rows through the live-stream
// matcher and the database listing. The live stream broadcasts committed rows to
// the console directly, so if the Go predicate and the SQL drift apart, a
// filtered view shows one set of rows in its history and another as events
// arrive.
func TestLogFilterMatchesAgreesWithSQL(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO api_tokens (id, name, token, token_hash, token_preview)
        VALUES (10, 'token-a', 'tok-a', 'hash-a', 'preview'),
               (20, 'token-b', 'tok-b', 'hash-b', 'preview')`); err != nil {
		t.Fatalf("seed tokens: %v", err)
	}

	rows := []models.RequestLogOut{
		{ID: 1, ClientType: "codex", StatusCode: int32Ptr(200), DownstreamTokenID: int64Ptr(10),
			DownstreamTokenName: stringPtr("shared"), Model: stringPtr("gpt-test")},
		{ID: 2, ClientType: "codex", StatusCode: int32Ptr(302), DownstreamTokenID: int64Ptr(10),
			DownstreamTokenName: stringPtr("shared"), Model: stringPtr("gpt-test")},
		{ID: 3, ClientType: "claude", StatusCode: int32Ptr(404), DownstreamTokenID: int64Ptr(20),
			DownstreamTokenName: stringPtr("shared"), Model: stringPtr("claude-test")},
		{ID: 4, ClientType: "claude", StatusCode: int32Ptr(499), DownstreamTokenID: int64Ptr(20),
			DownstreamTokenName: stringPtr("shared"), Model: stringPtr("claude-test")},
		{ID: 5, ClientType: "codex", StatusCode: int32Ptr(502), DownstreamTokenID: int64Ptr(20),
			DownstreamTokenName: stringPtr("shared"), Model: stringPtr("gpt-test")},
		{ID: 6, ClientType: "codex", StatusCode: nil, DownstreamTokenID: int64Ptr(20),
			DownstreamTokenName: stringPtr("shared"), Model: stringPtr("gpt-test")},
	}
	for _, row := range rows {
		_, err := database.Exec(`INSERT INTO request_logs
            (id, created_at, method, path, client_type, downstream_token_id,
             downstream_token_name, model, stream, status_code)
            VALUES (?, datetime('now'), 'POST', '/v1/chat', ?, ?, ?, ?, 0, ?)`,
			row.ID, row.ClientType, row.DownstreamTokenID, row.DownstreamTokenName,
			row.Model, row.StatusCode)
		if err != nil {
			t.Fatalf("insert log %d: %v", row.ID, err)
		}
	}

	filters := []struct {
		name   string
		filter LogFilter
	}{
		{name: "no filter", filter: LogFilter{}},
		{name: "error", filter: LogFilter{Status: stringPtr(LogStatusError)}},
		{name: "other", filter: LogFilter{Status: stringPtr(LogStatusOther)}},
		{name: "none", filter: LogFilter{Status: stringPtr(LogStatusNone)}},
		{name: "4xx includes 499", filter: LogFilter{Status: stringPtr(LogStatus4xx)}},
		{name: "token id", filter: LogFilter{DownstreamTokenID: int64Ptr(20)}},
		{name: "token id and error", filter: LogFilter{
			DownstreamTokenID: int64Ptr(20), Status: stringPtr(LogStatusError)}},
		{name: "client type", filter: LogFilter{ClientType: stringPtr("codex")}},
		{name: "search model", filter: LogFilter{Search: stringPtr("claude-test")}},
		{name: "search status code", filter: LogFilter{Search: stringPtr("502")}},
	}

	for _, testCase := range filters {
		t.Run(testCase.name, func(t *testing.T) {
			listed, err := ListLogs(ctx, database, 100, 0, nil, testCase.filter)
			if err != nil {
				t.Fatalf("list logs: %v", err)
			}
			wantIDs := logIDs(listed)

			gotIDs := []int64{}
			for _, row := range rows {
				if testCase.filter.Matches(row) {
					gotIDs = append(gotIDs, row.ID)
				}
			}

			if !sameInts(gotIDs, wantIDs) {
				t.Errorf("live matcher selected %v, SQL selected %v", gotIDs, wantIDs)
			}
		})
	}
}
