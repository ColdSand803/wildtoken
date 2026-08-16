package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// bulkStatsResponse mirrors the wire shape the card view consumes.
type bulkStatsResponse struct {
	Stats map[string]struct {
		Sparkline []struct {
			Bucket string `json:"bucket"`
			Count  int64  `json:"count"`
		} `json:"sparkline"`
		TotalRequests  int64   `json:"totalRequests"`
		CacheHitRate   float64 `json:"cacheHitRate"`
		AvgTokensPer1M float64 `json:"avgTokensPer1M"`
	} `json:"stats"`
}

// TestBulkChannelStatsGroupsPerChannel seeds logs for two channels and checks
// the single bulk response carries each channel's own totals: the card view
// fires exactly one request for the whole grid, so a grouping mistake here
// would show every card the same numbers.
func TestBulkChannelStatsGroupsPerChannel(t *testing.T) {
	state := upstreamTestState(t)

	// request_logs.upstream_id carries a foreign key to upstreams.
	if _, err := state.DB.Exec(`
		INSERT INTO upstreams (id, name, base_url) VALUES
			(1, 'stats-a', 'https://a.example.com'),
			(2, 'stats-b', 'https://b.example.com')
	`); err != nil {
		t.Fatalf("seed upstreams: %v", err)
	}

	// Channel 1: two recent requests inside the 6h sparkline window, half the
	// prompt tokens served from cache. Channel 2: one old request outside the
	// window — lifetime totals must still count it while the sparkline must not.
	_, err := state.DB.Exec(`
		INSERT INTO request_logs
			(created_at, method, path, client_type, upstream_id,
			 prompt_tokens, prompt_cached_tokens, total_tokens)
		VALUES
			(datetime('now', '-10 minutes'), 'POST', '/v1/chat', 'test', 1, 100, 50, 150),
			(datetime('now', '-40 minutes'), 'POST', '/v1/chat', 'test', 1, 100, 50, 250),
			(datetime('now', '-2 days'),     'POST', '/v1/chat', 'test', 2, 300, 0,  400),
			(datetime('now', '-5 minutes'),  'POST', '/v1/chat', 'test', NULL, 10, 0, 20)
	`)
	if err != nil {
		t.Fatalf("seed logs: %v", err)
	}

	// Mount the routes the way the real router does, so the static /stats
	// path is proven to win over the /{id} parameter route.
	router := chi.NewRouter()
	router.Get("/api/admin/upstreams/{id}", AdminGetUpstream(state))
	router.Get("/api/admin/upstreams/stats", AdminGetUpstreamsStats(state))

	request := httptest.NewRequest(http.MethodGet, "/api/admin/upstreams/stats", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("bulk stats returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var payload bulkStatsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}

	first, ok := payload.Stats["1"]
	if !ok {
		t.Fatalf("channel 1 missing from response: %s", recorder.Body.String())
	}
	if first.TotalRequests != 2 {
		t.Errorf("channel 1 totalRequests = %d, want 2", first.TotalRequests)
	}
	if first.CacheHitRate != 50 {
		t.Errorf("channel 1 cacheHitRate = %v, want 50", first.CacheHitRate)
	}
	// (150+250)/2 requests × 1000 = 200000 tokens per thousand requests.
	if first.AvgTokensPer1M != 200000 {
		t.Errorf("channel 1 avgTokensPer1M = %v, want 200000", first.AvgTokensPer1M)
	}
	var sparklineTotal int64
	for _, point := range first.Sparkline {
		sparklineTotal += point.Count
	}
	if sparklineTotal != 2 {
		t.Errorf("channel 1 sparkline counts sum = %d, want 2", sparklineTotal)
	}

	second, ok := payload.Stats["2"]
	if !ok {
		t.Fatalf("channel 2 missing from response: %s", recorder.Body.String())
	}
	if second.TotalRequests != 1 {
		t.Errorf("channel 2 totalRequests = %d, want 1", second.TotalRequests)
	}
	if len(second.Sparkline) != 0 {
		t.Errorf("channel 2 sparkline has %d buckets, want 0 (row is outside 6h)", len(second.Sparkline))
	}
	if second.CacheHitRate != 0 {
		t.Errorf("channel 2 cacheHitRate = %v, want 0", second.CacheHitRate)
	}

	// The NULL-upstream row must not invent a channel.
	if len(payload.Stats) != 2 {
		t.Errorf("response has %d channels, want 2", len(payload.Stats))
	}
}
