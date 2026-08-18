package db

import (
	"context"
	"testing"
)

// TestUpstreamHealthExcludesClientCancellations pins the corrected health
// accounting: a client-initiated 499 is not an upstream failure, a legitimate
// 0ms sample counts as a timed sample, and rows without a duration stay out of
// the latency average entirely.
func TestUpstreamHealthExcludesClientCancellations(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO upstreams (id, name, base_url)
        VALUES (1, 'primary', 'https://example.test')`); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}

	// 200 with 0ms, a client cancel (499), a real upstream failure (502)
	// without a duration, and a 200 with 100ms.
	rows := []struct {
		status   any
		duration any
	}{
		{200, 0},
		{499, 20},
		{502, nil},
		{200, 100},
	}
	for i, row := range rows {
		_, err := database.Exec(`INSERT INTO request_logs
            (method, path, client_type, upstream_id, stream, status_code, duration_ms, created_at)
            VALUES ('POST', '/v1/chat', 'test', 1, 0, ?, ?, datetime('now', '-10 minutes'))`,
			row.status, row.duration)
		if err != nil {
			t.Fatalf("insert log %d: %v", i, err)
		}
	}

	health, err := UpstreamHealthHistory(ctx, database, 24, nil)
	if err != nil {
		t.Fatalf("health history: %v", err)
	}
	entry, ok := health[1]
	if !ok {
		t.Fatal("channel 1 missing from health history")
	}

	if entry.Total != 4 {
		t.Errorf("total = %d, want 4", entry.Total)
	}
	// Only the 502 is an upstream failure; the 499 was the client leaving.
	if entry.Errors != 1 {
		t.Errorf("errors = %d, want 1 (499 must not count)", entry.Errors)
	}
	// 0ms, 20ms, and 100ms have durations; the 502 does not.
	if entry.TimedCount != 3 {
		t.Errorf("timed count = %d, want 3", entry.TimedCount)
	}
	// (0 + 20 + 100) / 3 = 40, weighted by timed samples rather than by all
	// requests, and with the legitimate 0ms sample included.
	if entry.AvgMs != 40 {
		t.Errorf("avg ms = %v, want 40", entry.AvgMs)
	}
}

// TestUpstreamHealthWeightsAveragesByTimedSamples verifies that a window
// spanning several hourly buckets re-aggregates to the same value as averaging
// the raw timed samples, which the old request-count weighting broke whenever
// buckets held different numbers of untimed rows.
func TestUpstreamHealthWeightsAveragesByTimedSamples(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO upstreams (id, name, base_url)
        VALUES (1, 'primary', 'https://example.test')`); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}

	// Bucket A: one timed 900ms row plus two untimed rows.
	// Bucket B: one timed 100ms row.
	// Raw timed average is (900 + 100) / 2 = 500.
	inserts := []struct {
		offset   string
		status   any
		duration any
	}{
		{"-30 minutes", 200, 900},
		{"-30 minutes", 502, nil},
		{"-30 minutes", 502, nil},
		{"-3 hours", 200, 100},
	}
	for i, row := range inserts {
		_, err := database.Exec(`INSERT INTO request_logs
            (method, path, client_type, upstream_id, stream, status_code, duration_ms, created_at)
            VALUES ('POST', '/v1/chat', 'test', 1, 0, ?, ?, datetime('now', ?))`,
			row.status, row.duration, row.offset)
		if err != nil {
			t.Fatalf("insert log %d: %v", i, err)
		}
	}

	health, err := UpstreamHealthHistory(ctx, database, 24, nil)
	if err != nil {
		t.Fatalf("health history: %v", err)
	}
	entry, ok := health[1]
	if !ok {
		t.Fatal("channel 1 missing from health history")
	}

	if entry.TimedCount != 2 {
		t.Errorf("timed count = %d, want 2", entry.TimedCount)
	}
	if entry.AvgMs != 500 {
		t.Errorf("avg ms = %v, want 500 weighted by timed samples", entry.AvgMs)
	}
}

// TestUpstreamHealthExcludesProbeClientTypes pins the separation between the two
// things a channel card reports. Console probes live in request_logs so the log
// page can filter them, but "24h 流量健康" answers how the channel serves real
// traffic -- and a failing probe an operator just fired must not move that
// number. Batch probing every channel would otherwise rewrite the whole board.
func TestUpstreamHealthExcludesProbeClientTypes(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.Exec(`INSERT INTO upstreams (id, name, base_url)
        VALUES (1, 'primary', 'https://example.test')`); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}

	// One successful proxied request, then three failing probes of the kinds the
	// console fires. Without the exclusion the channel reads as 25% healthy.
	rows := []struct {
		clientType string
		status     any
		duration   any
	}{
		{"codex", 200, 100},
		{"channel-test", 502, 20},
		{"model-test", 401, 30},
		{"model-list", nil, nil},
	}
	for i, row := range rows {
		_, err := database.Exec(`INSERT INTO request_logs
            (method, path, client_type, upstream_id, stream, status_code, duration_ms, created_at)
            VALUES ('POST', '/v1/chat', ?, 1, 0, ?, ?, datetime('now', '-10 minutes'))`,
			row.clientType, row.status, row.duration)
		if err != nil {
			t.Fatalf("insert log %d: %v", i, err)
		}
	}

	excluded := []string{"model-test", "channel-test", "model-list", "balance"}
	health, err := UpstreamHealthHistory(ctx, database, 24, excluded)
	if err != nil {
		t.Fatalf("health history: %v", err)
	}
	entry, ok := health[1]
	if !ok {
		t.Fatal("channel 1 missing from health history")
	}

	if entry.Total != 1 {
		t.Errorf("total = %d, want 1 (probes excluded)", entry.Total)
	}
	if entry.Errors != 0 {
		t.Errorf("errors = %d, want 0 (probe failures are not channel failures)", entry.Errors)
	}
	if entry.SuccessRate != 1 {
		t.Errorf("success rate = %v, want 1", entry.SuccessRate)
	}
	if entry.TimedCount != 1 {
		t.Errorf("timed count = %d, want 1", entry.TimedCount)
	}
	if entry.AvgMs != 100 {
		t.Errorf("avg ms = %v, want 100 (probe latencies excluded)", entry.AvgMs)
	}

	// Without the exclusion the same rows still aggregate, so the filter is
	// what changed the answer rather than the fixture being empty.
	unfiltered, err := UpstreamHealthHistory(ctx, database, 24, nil)
	if err != nil {
		t.Fatalf("unfiltered health history: %v", err)
	}
	if unfiltered[1].Total != 4 {
		t.Errorf("unfiltered total = %d, want 4", unfiltered[1].Total)
	}
}
