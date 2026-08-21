package db

import (
	"context"
	"testing"
)

// TestLogFilterStatusCategories verifies the six status categories against
// status codes 200, 302, 404, 499, 502, NULL, ensuring `other`, `none`, and
// `error` match exactly their SQL predicates.
func TestLogFilterStatusCategories(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO upstreams (id, name, base_url)
        VALUES (1, 'test', 'https://example.test')`); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}

	rows := []struct {
		id     int
		status any
	}{
		{1, 200},
		{2, 302},
		{3, 404},
		{4, 499},
		{5, 502},
		{6, nil},
	}
	for _, row := range rows {
		_, err := database.Exec(`INSERT INTO request_logs
            (id, method, path, client_type, upstream_id, stream, status_code)
            VALUES (?, 'POST', '/v1/chat', 'test', 1, 0, ?)`,
			row.id, row.status)
		if err != nil {
			t.Fatalf("insert log %d: %v", row.id, err)
		}
	}

	testCases := []struct {
		status  string
		wantIDs []int64
	}{
		{LogStatus2xx, []int64{1}},
		{LogStatus4xx, []int64{3, 4}},
		{LogStatus5xx, []int64{5}},
		{LogStatusOther, []int64{2}},
		{LogStatusNone, []int64{6}},
		{LogStatusError, []int64{2, 3, 4, 5, 6}},
	}

	for _, tc := range testCases {
		t.Run(tc.status, func(t *testing.T) {
			filter := LogFilter{Status: &tc.status}
			items, err := ListLogs(ctx, database, 100, 0, nil, filter)
			if err != nil {
				t.Fatalf("list logs: %v", err)
			}
			gotIDs := logIDs(items)
			if !sameInts(gotIDs, tc.wantIDs) {
				t.Errorf("%s matched %v, want %v", tc.status, gotIDs, tc.wantIDs)
			}
		})
	}
}

func sameInts(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[int64]bool, len(a))
	for _, v := range a {
		seen[v] = true
	}
	for _, v := range b {
		if !seen[v] {
			return false
		}
	}
	return true
}
