package db

import (
	"context"
	"strings"
	"testing"
)

func TestInitDropsTheUnusedDescendingIndexes(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// A database created by an older build carries them. Init has to remove
	// them, not merely stop creating them, or every existing deployment keeps
	// paying their write cost forever.
	for _, statement := range []string{
		"CREATE INDEX IF NOT EXISTS idx_request_logs_created_at_id_desc ON request_logs(created_at DESC, id DESC);",
		"CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at_id_desc ON request_logs(upstream_id, created_at DESC, id DESC);",
	} {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			t.Fatalf("recreate legacy index: %v", err)
		}
	}

	if err := Init(ctx, database); err != nil {
		t.Fatalf("init: %v", err)
	}

	for _, name := range []string{
		"idx_request_logs_created_at_id_desc",
		"idx_request_logs_upstream_created_at_id_desc",
	} {
		var count int64
		if err := database.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?",
			name).Scan(&count); err != nil {
			t.Fatalf("lookup %s: %v", name, err)
		}
		if count != 0 {
			t.Errorf("index %s survived Init", name)
		}
	}

	// The indexes that do the work stay.
	for _, name := range []string{
		"idx_request_logs_created_at",
		"idx_request_logs_upstream_created_at",
		"idx_request_logs_downstream_token_created_at",
	} {
		var count int64
		if err := database.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?",
			name).Scan(&count); err != nil {
			t.Fatalf("lookup %s: %v", name, err)
		}
		if count != 1 {
			t.Errorf("index %s is missing", name)
		}
	}
}

func TestNewestFirstListingNeedsNoTemporarySort(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// The dropped indexes existed to serve this ordering. id is the rowid,
	// which every index entry already carries, so a reverse scan of the ASC
	// index satisfies it — the point being that no sort appears here.
	for _, query := range []string{
		"SELECT id FROM request_logs ORDER BY created_at DESC, id DESC LIMIT 51",
		"SELECT id FROM request_logs WHERE upstream_id = 2 ORDER BY created_at DESC, id DESC LIMIT 51",
	} {
		rows, err := database.QueryContext(ctx, "EXPLAIN QUERY PLAN "+query)
		if err != nil {
			t.Fatalf("explain: %v", err)
		}
		var plan string
		for rows.Next() {
			var id, parent, notUsed int64
			var detail string
			if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
				rows.Close()
				t.Fatalf("scan: %v", err)
			}
			plan += detail + "\n"
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatalf("rows: %v", err)
		}
		if strings.Contains(plan, "TEMP B-TREE") {
			t.Errorf("query needs a temporary sort:\n%s", plan)
		}
	}
}
