package handlers

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// usageReportingUpstream answers with a body carrying the usage block a provider
// returns, so the settlement path has something real to price.
func usageReportingUpstream(t *testing.T, promptTokens, completionTokens,
	cachedTokens int) *httptest.Server {
	t.Helper()
	body := `{"id":"x","choices":[{"message":{"content":"hi"}}],"usage":{` +
		`"prompt_tokens":` + itoa(int64(promptTokens)) +
		`,"completion_tokens":` + itoa(int64(completionTokens)) +
		`,"total_tokens":` + itoa(int64(promptTokens+completionTokens)) +
		`,"prompt_tokens_details":{"cached_tokens":` + itoa(int64(cachedTokens)) + `}}}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

// costRow is a settled request as the console reads it back.
type costRow struct {
	model         sql.NullString
	costMicros    sql.NullInt64
	costCurrency  sql.NullString
	pricingRuleID sql.NullInt64
	totalTokens   sql.NullInt64
}

func readCostRows(t *testing.T, database *sql.DB) []costRow {
	t.Helper()
	rows, err := database.Query(`SELECT request_model, cost_micros, cost_currency,
	    pricing_rule_id, total_tokens FROM request_logs ORDER BY id`)
	if err != nil {
		t.Fatalf("query costs: %v", err)
	}
	defer rows.Close()

	var settled []costRow
	for rows.Next() {
		var row costRow
		if err := rows.Scan(&row.model, &row.costMicros, &row.costCurrency,
			&row.pricingRuleID, &row.totalTokens); err != nil {
			t.Fatalf("scan cost: %v", err)
		}
		settled = append(settled, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return settled
}

// priceModel adds a price version and refreshes the in-memory book the settlement
// path reads, the way the admin endpoint does.
func priceModel(t *testing.T, state *appstate.State, pattern string,
	promptMicros, completionMicros, cacheReadMicros int64) models.PricingRule {
	t.Helper()
	rule, err := db.CreatePricingRule(context.Background(), state.DB, &models.PricingRuleIn{
		ModelPattern: pattern, Currency: models.CurrencyUSD,
		PromptMicros: promptMicros, CompletionMicros: completionMicros,
		CacheReadMicros: cacheReadMicros,
	})
	if err != nil {
		t.Fatalf("price %s: %v", pattern, err)
	}
	rules, err := db.ListPricingRules(context.Background(), state.DB)
	if err != nil {
		t.Fatalf("reload prices: %v", err)
	}
	state.Pricing.Replace(rules)
	return rule
}

// TestAProxiedRequestStoresItsCostSnapshot is P2-2 end to end: a real request
// through the handler lands an amount, a currency and a version in its log row.
func TestAProxiedRequestStoresItsCostSnapshot(t *testing.T) {
	state := noBackoffState(t)
	upstream := usageReportingUpstream(t, 1_000_000, 500_000, 0)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	// $2.50 per million prompt, $10.00 per million completion.
	rule := priceModel(t, state, "test-model", 2_500_000, 10_000_000, 0)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequestForModel(router, "caller-token", `{"model":"test-model"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}

	state.LogWriter.Close()
	settled := readCostRows(t, state.DB)
	if len(settled) != 1 {
		t.Fatalf("wrote %d rows, want one", len(settled))
	}
	row := settled[0]

	// $2.50 + $5.00 = $7.50.
	if !row.costMicros.Valid {
		t.Fatal("cost_micros is NULL for a priced model")
	}
	if want := int64(7_500_000); row.costMicros.Int64 != want {
		t.Errorf("cost_micros = %d, want %d ($7.50)", row.costMicros.Int64, want)
	}
	if row.costCurrency.String != models.CurrencyUSD {
		t.Errorf("cost_currency = %q, want USD", row.costCurrency.String)
	}
	if row.pricingRuleID.Int64 != rule.ID {
		t.Errorf("pricing_rule_id = %d, want %d", row.pricingRuleID.Int64, rule.ID)
	}
}

// TestAnUnpricedRequestLeavesTheCostColumnsNull keeps a model nobody priced out of
// the totals, rather than counted as free.
func TestAnUnpricedRequestLeavesTheCostColumnsNull(t *testing.T) {
	state := noBackoffState(t)
	upstream := usageReportingUpstream(t, 1_000, 500, 0)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	// A price for some other model, so the table is not empty — the request must
	// still be unpriced rather than falling onto an unrelated rule.
	priceModel(t, state, "a-different-model", 2_500_000, 10_000_000, 0)
	router := proxyRateLimitRouter(state)

	if response := sendProxyRequestForModel(router, "caller-token",
		`{"model":"test-model"}`); response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}

	state.LogWriter.Close()
	settled := readCostRows(t, state.DB)
	if len(settled) != 1 {
		t.Fatalf("wrote %d rows, want one", len(settled))
	}
	row := settled[0]

	if row.costMicros.Valid {
		t.Errorf("cost_micros = %d for an unpriced model, want NULL", row.costMicros.Int64)
	}
	if row.costCurrency.Valid || row.pricingRuleID.Valid {
		t.Error("cost_currency or pricing_rule_id is set without an amount")
	}
	// The usage was still recorded: only the cost is unknown.
	if !row.totalTokens.Valid || row.totalTokens.Int64 != 1_500 {
		t.Errorf("total_tokens = %v, want the usage recorded regardless of pricing",
			row.totalTokens)
	}
}

// TestACachedRequestIsBilledAtTheCacheRate is the double-billing rule reaching the
// database, not just the arithmetic unit test.
func TestACachedRequestIsBilledAtTheCacheRate(t *testing.T) {
	state := noBackoffState(t)
	// 1M prompt tokens of which 900k were cache hits.
	upstream := usageReportingUpstream(t, 1_000_000, 0, 900_000)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	// $10/M fresh prompt, $1/M cache read.
	priceModel(t, state, "test-model", 10_000_000, 0, 1_000_000)
	router := proxyRateLimitRouter(state)

	if response := sendProxyRequestForModel(router, "caller-token",
		`{"model":"test-model"}`); response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}

	state.LogWriter.Close()
	settled := readCostRows(t, state.DB)
	if len(settled) != 1 {
		t.Fatalf("wrote %d rows, want one", len(settled))
	}

	// 100k fresh at $10/M = $1.00, plus 900k cached at $1/M = $0.90 → $1.90.
	// The double-billed figure would be $10.90.
	if want := int64(1_900_000); settled[0].costMicros.Int64 != want {
		t.Errorf("cost_micros = %d, want %d ($1.90): the cached portion is billed once",
			settled[0].costMicros.Int64, want)
	}
}

// TestTheCostSnapshotSurvivesAPriceEdit is the completion standard at the
// database: settle, raise the price, and the stored figure is unchanged.
func TestTheCostSnapshotSurvivesAPriceEdit(t *testing.T) {
	state := noBackoffState(t)
	upstream := usageReportingUpstream(t, 1_000_000, 0, 0)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	first := priceModel(t, state, "test-model", 2_000_000, 0, 0)
	router := proxyRateLimitRouter(state)

	if response := sendProxyRequestForModel(router, "caller-token",
		`{"model":"test-model"}`); response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	state.LogWriter.Close()

	before := readCostRows(t, state.DB)
	if len(before) != 1 || before[0].costMicros.Int64 != 2_000_000 {
		t.Fatalf("first settlement = %+v, want $2.00", before)
	}

	// The operator doubles the price. The already-written row must not move.
	priceModel(t, state, "test-model", 4_000_000, 0, 0)

	after := readCostRows(t, state.DB)
	if len(after) != 1 {
		t.Fatalf("read %d rows after the price edit, want one", len(after))
	}
	if after[0].costMicros.Int64 != 2_000_000 {
		t.Errorf("cost_micros = %d after a price edit, want the original $2.00",
			after[0].costMicros.Int64)
	}
	if after[0].pricingRuleID.Int64 != first.ID {
		t.Errorf("pricing_rule_id = %d after a price edit, want the original version %d",
			after[0].pricingRuleID.Int64, first.ID)
	}
}

// TestTheCostIsPricedOnTheClientsModelNotTheMappedOne keeps a channel's model
// mapping from moving a request onto another model's rate, which is the same
// ordering the whitelist enforces.
func TestTheCostIsPricedOnTheClientsModelNotTheMappedOne(t *testing.T) {
	state := noBackoffState(t)
	upstream := usageReportingUpstream(t, 1_000_000, 0, 0)

	insertCallerToken(t, state.DB, "caller-token")
	input := models.DefaultUpstreamIn()
	input.Name = "mapping"
	input.BaseURL = upstream.URL
	input.ModelNames = []string{"expensive-upstream-model"}
	input.ModelMappings = map[string]string{"cheap-client-model": "expensive-upstream-model"}
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input, 30); err != nil {
		t.Fatalf("create channel: %v", err)
	}

	// The client-side id is cheap; the upstream-side id is dear. A request naming
	// the client id must be charged the cheap rate, because that is the id the
	// operator's price sheet is written against.
	priceModel(t, state, "cheap-client-model", 1_000_000, 0, 0)
	priceModel(t, state, "expensive-upstream-model", 90_000_000, 0, 0)
	router := proxyRateLimitRouter(state)

	if response := sendProxyRequestForModel(router, "caller-token",
		`{"model":"cheap-client-model"}`); response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}

	state.LogWriter.Close()
	settled := readCostRows(t, state.DB)
	if len(settled) != 1 {
		t.Fatalf("wrote %d rows, want one", len(settled))
	}
	if want := int64(1_000_000); settled[0].costMicros.Int64 != want {
		t.Errorf("cost_micros = %d, want %d: priced on the mapped model instead",
			settled[0].costMicros.Int64, want)
	}
}
