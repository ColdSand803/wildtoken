package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func testPolicy() AutoWeightPolicy {
	settings := models.DefaultRuntimeSettings()
	return NewAutoWeightPolicy(&settings)
}

func testDB(t *testing.T) *sql.DB {
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

func insertUpstream(t *testing.T, database *sql.DB, name string, modelNames []string,
	priority int32, weight int64, autoWeightEnabled bool) {
	t.Helper()
	encoded, err := json.Marshal(modelNames)
	if err != nil {
		t.Fatalf("encode model names: %v", err)
	}
	enabled := int64(0)
	if autoWeightEnabled {
		enabled = 1
	}
	_, err = database.Exec(`INSERT INTO upstreams
        (name, base_url, model_names, model_prefixes, model_mappings,
         priority, weight, auto_weight_enabled, enabled, extra_headers, timeout_seconds)
        VALUES (?, 'https://example.test', ?, '[]', '{}', ?, ?, ?, 1, '{}', 300.0)`,
		name, string(encoded), priority, weight, enabled)
	if err != nil {
		t.Fatalf("insert upstream %s: %v", name, err)
	}
}

// selectWithFreshCache mirrors the Rust test helper, which built a new cache per
// call so each selection reloads from SQLite.
func selectWithFreshCache(t *testing.T, database *sql.DB, autoWeight *AutoWeightManager,
	selector, model *string) *Selection {
	t.Helper()
	selection, err := SelectUpstream(context.Background(), database, NewRoutingCache(),
		autoWeight, testPolicy(), selector, model)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	return selection
}

func ptr[T any](value T) *T { return &value }

func TestPoolSelectionRejectsOnlyEnabledChannelWhenModelDoesNotMatch(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "deepseek-only", []string{"DeepSeek-V4-Flash"}, 100, 100, true)

	if selection := selectWithFreshCache(t, database, NewAutoWeightManager(),
		nil, ptr("gpt-5.5")); selection != nil {
		t.Errorf("selected %q for an unmatched model", selection.Upstream.Name)
	}
}

func TestDirectSelectionCannotBypassModelMatching(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "deepseek-only", []string{"DeepSeek-V4-Flash"}, 100, 0, true)
	autoWeight := NewAutoWeightManager()

	if selection := selectWithFreshCache(t, database, autoWeight,
		ptr("deepseek-only"), ptr("gpt-5.5")); selection != nil {
		t.Error("direct selection by name bypassed model matching")
	}
	if selection := selectWithFreshCache(t, database, autoWeight,
		ptr("1"), ptr("gpt-5.5")); selection != nil {
		t.Error("direct selection by id bypassed model matching")
	}
}

func TestNumericDirectSelectionFallsBackToNameWhenIDDoesNotMatch(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "id-one", []string{"other-model"}, 100, 100, true)
	insertUpstream(t, database, "1", []string{"target-model"}, 100, 100, true)

	selection := selectWithFreshCache(t, database, NewAutoWeightManager(),
		ptr("1"), ptr("target-model"))
	if selection == nil || selection.Upstream.Name != "1" {
		t.Fatalf("selection = %+v, want the upstream named \"1\"", selection)
	}
}

func TestMatchingModelStillSelectsEnabledChannel(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "deepseek-only", []string{"DeepSeek-V4-Flash"}, 100, 100, true)

	selection := selectWithFreshCache(t, database, NewAutoWeightManager(),
		nil, ptr("DeepSeek-V4-Flash"))
	if selection == nil || selection.Upstream.Name != "deepseek-only" {
		t.Fatalf("selection = %+v, want deepseek-only", selection)
	}
	if selection.ForwardModel == nil || *selection.ForwardModel != "DeepSeek-V4-Flash" {
		t.Errorf("forward model = %v, want DeepSeek-V4-Flash", selection.ForwardModel)
	}
}

func TestRoutingCacheReusesSnapshotUntilInvalidated(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "cached", []string{"first-model"}, 100, 100, true)
	cache := NewRoutingCache()
	autoWeight := NewAutoWeightManager()

	selectVia := func(model string) *Selection {
		t.Helper()
		selection, err := SelectUpstream(context.Background(), database, cache,
			autoWeight, testPolicy(), nil, &model)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		return selection
	}

	if selection := selectVia("first-model"); selection == nil || selection.Upstream.Name != "cached" {
		t.Fatalf("first selection = %+v, want cached", selection)
	}
	if !cache.isCached() {
		t.Error("a successful load left the cache empty")
	}

	if _, err := database.Exec(
		`UPDATE upstreams SET model_names = '["second-model"]' WHERE name = 'cached'`); err != nil {
		t.Fatalf("update: %v", err)
	}

	// The cached snapshot still answers with the old model until invalidation.
	if selection := selectVia("first-model"); selection == nil || selection.Upstream.Name != "cached" {
		t.Fatalf("stale selection = %+v, want the cached snapshot", selection)
	}

	cache.Invalidate()
	if selection := selectVia("first-model"); selection != nil {
		t.Error("the old model still matched after invalidation")
	}
	if selection := selectVia("second-model"); selection == nil || selection.Upstream.Name != "cached" {
		t.Fatalf("reloaded selection = %+v, want cached", selection)
	}
}

func TestHigherPriorityWinsEvenWithASmallerWeight(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "primary", []string{"model"}, 999, 1, true)
	insertUpstream(t, database, "fallback", []string{"model"}, 998, 10000, true)
	autoWeight := NewAutoWeightManager()

	for range 20 {
		selection := selectWithFreshCache(t, database, autoWeight, nil, ptr("model"))
		if selection == nil || selection.Upstream.Name != "primary" {
			t.Fatalf("selection = %+v, want primary every time", selection)
		}
	}
}

func TestZeroBaseWeightIsNeverSelectedFromAWeightedGroup(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "zero", []string{"model"}, 999, 0, true)
	insertUpstream(t, database, "active", []string{"model"}, 999, 1, true)
	autoWeight := NewAutoWeightManager()

	for range 20 {
		selection := selectWithFreshCache(t, database, autoWeight, nil, ptr("model"))
		if selection == nil || selection.Upstream.Name != "active" {
			t.Fatalf("selection = %+v, want active every time", selection)
		}
	}
}

func TestModelMatchScoreIsResolvedBeforePriority(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "prefix", nil, 999, 100, true)
	insertUpstream(t, database, "mapping", nil, 100, 100, true)
	if _, err := database.Exec(
		`UPDATE upstreams SET model_prefixes = '["gpt-"]' WHERE name = 'prefix'`); err != nil {
		t.Fatalf("set prefixes: %v", err)
	}
	if _, err := database.Exec(
		`UPDATE upstreams SET model_mappings = '{"gpt-test":"provider-model"}' WHERE name = 'mapping'`); err != nil {
		t.Fatalf("set mappings: %v", err)
	}

	selection := selectWithFreshCache(t, database, NewAutoWeightManager(), nil, ptr("gpt-test"))
	if selection == nil || selection.Upstream.Name != "mapping" {
		t.Fatalf("selection = %+v, want the exact mapping to beat the higher-priority prefix", selection)
	}
	if selection.ForwardModel == nil || *selection.ForwardModel != "provider-model" {
		t.Errorf("forward model = %v, want provider-model", selection.ForwardModel)
	}
}

func TestExactModelNameAndMappingTieBeforePriority(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "native", []string{"gpt-test"}, 999, 100, true)
	insertUpstream(t, database, "mapping", nil, 100, 100, true)
	if _, err := database.Exec(
		`UPDATE upstreams SET model_mappings = '{"gpt-test":"provider-model"}' WHERE name = 'mapping'`); err != nil {
		t.Fatalf("set mappings: %v", err)
	}

	for _, name := range []string{"native", "mapping"} {
		row, ok, err := db.GetUpstreamByName(context.Background(), database, name)
		if err != nil || !ok {
			t.Fatalf("load %s: %v (ok=%v)", name, err, ok)
		}
		if score := modelMatchScore(newParsedUpstream(row), ptr("gpt-test")); score != 4 {
			t.Errorf("%s scored %d, want 4", name, score)
		}
	}

	selection := selectWithFreshCache(t, database, NewAutoWeightManager(), nil, ptr("gpt-test"))
	if selection == nil || selection.Upstream.Name != "native" {
		t.Fatalf("selection = %+v, want priority to break the score tie", selection)
	}
	if selection.ForwardModel == nil || *selection.ForwardModel != "gpt-test" {
		t.Errorf("forward model = %v, want gpt-test", selection.ForwardModel)
	}
}

func TestZeroHealthPriorityGroupFallsBackToTheNextGroup(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "primary", []string{"model"}, 999, 100, true)
	insertUpstream(t, database, "fallback", []string{"model"}, 998, 100, true)
	autoWeight := NewAutoWeightManager()
	for range 5 {
		autoWeight.RecordFailure(1, true, testPolicy())
	}

	selection := selectWithFreshCache(t, database, autoWeight, nil, ptr("model"))
	if selection == nil || selection.Upstream.Name != "fallback" {
		t.Fatalf("selection = %+v, want fallback", selection)
	}
}

func TestDirectSelectionBypassesZeroWeightAndZeroHealth(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "direct", []string{"model"}, 999, 0, true)
	autoWeight := NewAutoWeightManager()
	for range 5 {
		autoWeight.RecordFailure(1, true, testPolicy())
	}

	if selection := selectWithFreshCache(t, database, autoWeight, nil, ptr("model")); selection != nil {
		t.Error("pool selection returned a zero-weight upstream")
	}
	selection := selectWithFreshCache(t, database, autoWeight, ptr("direct"), ptr("model"))
	if selection == nil || selection.Upstream.Name != "direct" {
		t.Fatalf("selection = %+v, want direct selection to bypass weight and health", selection)
	}
}

func TestFixedHealthAdjustmentsAndTimeRecoveryAreBounded(t *testing.T) {
	autoWeight := NewAutoWeightManager()
	policy := testPolicy()

	for range 5 {
		autoWeight.RecordFailure(7, true, policy)
	}
	if score := autoWeight.Snapshot(7, 100, true, policy).Score; score != 0 {
		t.Fatalf("score after five failures = %d, want 0 (floored)", score)
	}

	autoWeight.setLastAdjustedAt(7, time.Now().Add(-61*time.Second))
	if score := autoWeight.Snapshot(7, 100, true, policy).Score; score != 10 {
		t.Fatalf("score after one recovery interval = %d, want 10", score)
	}

	autoWeight.RecordSuccess(7, true, policy)
	if score := autoWeight.Snapshot(7, 100, true, policy).Score; score != 15 {
		t.Fatalf("score after a success = %d, want 15", score)
	}
}

func TestDisabledAutoWeightIgnoresHealthUpdates(t *testing.T) {
	autoWeight := NewAutoWeightManager()
	policy := testPolicy()
	for range 10 {
		autoWeight.RecordFailure(9, false, policy)
	}

	snapshot := autoWeight.Snapshot(9, 25, false, policy)
	if snapshot.Score != 100 {
		t.Errorf("score = %d, want 100", snapshot.Score)
	}
	if snapshot.RoutingWeight != 2500 {
		t.Errorf("routing weight = %d, want 2500", snapshot.RoutingWeight)
	}
}

func TestWeightedSelectionHonorsWeightRatios(t *testing.T) {
	database := testDB(t)
	insertUpstream(t, database, "heavy", []string{"model"}, 100, 900, true)
	insertUpstream(t, database, "light", []string{"model"}, 100, 100, true)
	cache := NewRoutingCache()
	autoWeight := NewAutoWeightManager()

	counts := map[string]int{}
	const runs = 4000
	for range runs {
		selection, err := SelectUpstream(context.Background(), database, cache,
			autoWeight, testPolicy(), nil, ptr("model"))
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		counts[selection.Upstream.Name]++
	}

	// A 9:1 split over 4000 draws lands far inside these bounds; the range is
	// wide enough that the test does not flake on sampling noise.
	if counts["heavy"] < runs*80/100 || counts["heavy"] > runs*97/100 {
		t.Errorf("heavy won %d of %d draws, want roughly 90%%", counts["heavy"], runs)
	}
	if counts["light"] == 0 {
		t.Error("the light upstream was never selected")
	}
}
