package db

import (
	"context"
	"testing"
)

// TestListLogsFiltersByDownstreamTokenID pins the stable-ID drill-down: tokens
// that share a display name, carry no name at all, or were renamed after their
// requests were logged must each resolve to only their own history. The name
// snapshot cannot do this, which is why the filter takes an ID.
func TestListLogsFiltersByDownstreamTokenID(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// api_tokens.name is unique, so identical display names only ever appear in
	// the per-log name snapshots — exactly the case the ID filter has to
	// separate.
	tokens := []struct {
		id   int
		name string
	}{
		{10, "token-a"},
		{20, "token-b"},
		{30, "token-c"},
	}
	for _, token := range tokens {
		if _, err := database.Exec(`INSERT INTO api_tokens (id, name, token, token_hash, token_preview)
            VALUES (?, ?, ?, 'hash-' || ?, 'preview')`,
			token.id, token.name, "tok-"+itoa(token.id), itoa(token.id)); err != nil {
			t.Fatalf("insert token %d: %v", token.id, err)
		}
	}

	// Logs for token 10 and 20 both snapshot the display name "shared"; token
	// 30's row has no name at all; token 10's second row kept an older snapshot,
	// as happens when a token is renamed after the request was logged.
	rows := []struct {
		id        int
		tokenID   int
		tokenName any
	}{
		{1, 10, "shared"},
		{2, 10, "old-name"},
		{3, 20, "shared"},
		{4, 30, nil},
	}
	for _, row := range rows {
		_, err := database.Exec(`INSERT INTO request_logs
            (id, method, path, client_type, downstream_token_id, downstream_token_name,
             stream, status_code)
            VALUES (?, 'POST', '/v1/chat', 'test', ?, ?, 0, 200)`,
			row.id, row.tokenID, row.tokenName)
		if err != nil {
			t.Fatalf("insert log %d: %v", row.id, err)
		}
	}

	testCases := []struct {
		name    string
		tokenID int64
		wantIDs []int64
	}{
		{name: "same name, renamed snapshot", tokenID: 10, wantIDs: []int64{1, 2}},
		{name: "same name, different token", tokenID: 20, wantIDs: []int64{3}},
		{name: "empty name", tokenID: 30, wantIDs: []int64{4}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			tokenID := testCase.tokenID
			items, err := ListLogs(ctx, database, 100, 0, nil, LogFilter{DownstreamTokenID: &tokenID})
			if err != nil {
				t.Fatalf("list logs: %v", err)
			}
			if !sameInts(logIDs(items), testCase.wantIDs) {
				t.Errorf("token %d matched %v, want %v",
					tokenID, logIDs(items), testCase.wantIDs)
			}
		})
	}
}
