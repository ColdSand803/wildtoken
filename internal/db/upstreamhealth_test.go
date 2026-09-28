package db

import (
	"context"
	"testing"
)

// Hours follow the operator's offset. Aligned to UTC, a zone half an hour off
// read every hour as starting at half past.
func TestHealthHoursFollowTheOperatorsOffset(t *testing.T) {
	database := memoryDB(t)
	if _, err := database.Exec(`INSERT INTO upstreams (id, name, base_url) VALUES (7, 'c', 'https://x')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO request_logs
        (created_at, method, path, client_type, stream, status_code, upstream_id) VALUES
        (datetime('now', '-3 hours'), 'POST', 'r', 'codex', 0, 200, 7),
        (datetime('now', '-10 minutes'), 'POST', 'r', 'codex', 0, 500, 7)`); err != nil {
		t.Fatal(err)
	}

	const offset = 5*3600 + 1800
	health, err := UpstreamHealthHistory(context.Background(), database, 24, offset)
	if err != nil {
		t.Fatal(err)
	}
	entry := health[7]
	if entry == nil || entry.Total != 2 || entry.Errors != 1 {
		t.Fatalf("health = %+v", entry)
	}
	for _, bucket := range entry.Buckets {
		if (bucket.BucketEpoch+offset)%3600 != 0 {
			t.Errorf("bucket %d does not start on the operator's hour", bucket.BucketEpoch)
		}
	}
}
