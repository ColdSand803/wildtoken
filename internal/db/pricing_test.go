package db

import (
	"context"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func usdRuleIn(pattern string, promptMicros, completionMicros int64,
	effectiveFrom *string) models.PricingRuleIn {
	return models.PricingRuleIn{
		ModelPattern: pattern, Currency: models.CurrencyUSD,
		PromptMicros: promptMicros, CompletionMicros: completionMicros,
		EffectiveFrom: effectiveFrom,
	}
}

// TestPricingRulesRoundTripAsIntegers is the storage half of "no binary floats in
// billing": what goes in comes back bit for bit.
func TestPricingRulesRoundTripAsIntegers(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	// A price with a fraction no binary float holds exactly: $0.30 per million.
	created, err := CreatePricingRule(ctx, database, ptrTo(usdRuleIn("gpt-4o", 300_000, 1_200_000, nil)))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.PromptMicros != 300_000 || created.CompletionMicros != 1_200_000 {
		t.Fatalf("stored %d/%d micros, want 300000/1200000",
			created.PromptMicros, created.CompletionMicros)
	}

	read, ok, err := GetPricingRule(ctx, database, created.ID)
	if err != nil || !ok {
		t.Fatalf("read back: ok=%v err=%v", ok, err)
	}
	if read != created {
		t.Errorf("read back %+v, want %+v", read, created)
	}
	// An absent effective_from resolved to a concrete instant rather than being
	// left empty, so selection can compare it.
	if read.EffectiveFrom == "" {
		t.Error("effective_from is empty; selection compares it as a string")
	}
}

// TestAPriceChangeIsANewVersionNotAnEdit fixes the shape of the API: there is no
// update path, and the old version stays readable.
func TestAPriceChangeIsANewVersionNotAnEdit(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	january := "2026-01-01 00:00:00"
	june := "2026-06-01 00:00:00"

	first, err := CreatePricingRule(ctx, database, ptrTo(usdRuleIn("gpt-4o", 2_000_000, 0, &january)))
	if err != nil {
		t.Fatalf("create first: %v", err)
	}
	second, err := CreatePricingRule(ctx, database, ptrTo(usdRuleIn("gpt-4o", 4_000_000, 0, &june)))
	if err != nil {
		t.Fatalf("create second: %v", err)
	}

	rules, err := ListPricingRules(ctx, database)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rules) != 2 {
		t.Fatalf("listed %d rules, want both versions retained", len(rules))
	}
	// Newest effective first, which is the order the console shows.
	if rules[0].ID != second.ID {
		t.Errorf("first listed rule is %d, want the newer version %d", rules[0].ID, second.ID)
	}

	// Both versions still price their own era, which is what makes a past amount
	// explicable.
	if chosen, ok := models.SelectPricingRule(rules, "gpt-4o", "2026-03-01 00:00:00"); !ok ||
		chosen.ID != first.ID {
		t.Errorf("a March request selected %+v, want the January version", chosen)
	}
	if chosen, ok := models.SelectPricingRule(rules, "gpt-4o", "2026-08-01 00:00:00"); !ok ||
		chosen.ID != second.ID {
		t.Errorf("an August request selected %+v, want the June version", chosen)
	}
}

// TestDeletingAPriceVersionLeavesSettledAmountsIntact is why pricing_rule_id
// carries no foreign key: a deleted version must not erase the record of what a
// past request was charged.
func TestDeletingAPriceVersionLeavesSettledAmountsIntact(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	rule, err := CreatePricingRule(ctx, database, ptrTo(usdRuleIn("gpt-4o", 2_000_000, 0, nil)))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// A settled request naming that version.
	if _, err := database.ExecContext(ctx, `INSERT INTO request_logs
        (created_at, method, path, client_type, model, request_model, status_code,
         prompt_tokens, total_tokens, cost_micros, cost_currency, pricing_rule_id)
        VALUES ('2026-06-01 10:00:00', 'POST', 'chat/completions', 'codex',
                'gpt-4o', 'gpt-4o', 200, 1000000, 1000000, 2000000, 'USD', ?)`,
		rule.ID); err != nil {
		t.Fatalf("insert settled log: %v", err)
	}

	deleted, err := DeletePricingRule(ctx, database, rule.ID)
	if err != nil || !deleted {
		t.Fatalf("delete: deleted=%v err=%v", deleted, err)
	}

	entries, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("read %d log rows, want the settled one", len(entries))
	}
	settled := entries[0]
	if settled.CostMicros == nil || *settled.CostMicros != 2_000_000 {
		t.Errorf("cost_micros = %v after deleting the version, want 2000000 retained",
			settled.CostMicros)
	}
	if settled.PricingRuleID == nil || *settled.PricingRuleID != rule.ID {
		t.Errorf("pricing_rule_id = %v, want the deleted version's id retained",
			settled.PricingRuleID)
	}
	if settled.CostCurrency == nil || *settled.CostCurrency != models.CurrencyUSD {
		t.Errorf("cost_currency = %v, want USD retained", settled.CostCurrency)
	}
}

// TestCostColumnsMigrateOntoAnOlderDatabase: a row written before pricing must
// read as unknown cost, not as free.
func TestCostColumnsMigrateOntoAnOlderDatabase(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if _, err := database.ExecContext(ctx, "DROP TABLE request_logs"); err != nil {
		t.Fatalf("drop table: %v", err)
	}
	if _, err := database.ExecContext(ctx, requestLogsWithoutTimingColumns); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO request_logs
        (id, created_at, method, path, client_type, status_code, total_tokens)
        VALUES (1, '2026-05-01 10:00:00', 'POST', '/v1/chat', 'codex', 200, 5000)`); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	if err := Init(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	entries, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("read %d rows, want the migrated one", len(entries))
	}
	legacy := entries[0]
	// All three NULL together. A zero here would make a pre-pricing request look
	// free, and a dashboard summing the column would report a total that silently
	// excludes every request from before the feature existed.
	if legacy.CostMicros != nil {
		t.Errorf("cost_micros = %d on a pre-pricing row, want nil", *legacy.CostMicros)
	}
	if legacy.CostCurrency != nil {
		t.Errorf("cost_currency = %q on a pre-pricing row, want nil", *legacy.CostCurrency)
	}
	if legacy.PricingRuleID != nil {
		t.Errorf("pricing_rule_id = %d on a pre-pricing row, want nil", *legacy.PricingRuleID)
	}
	// The usage it did carry survives untouched.
	if legacy.TotalTokens == nil || *legacy.TotalTokens != 5000 {
		t.Errorf("total_tokens = %v, want 5000 preserved", legacy.TotalTokens)
	}
}

// TestAZeroPricedRuleStoresZeroNotNull keeps "free" distinct from "unknown" all
// the way through storage.
func TestAZeroPricedRuleStoresZeroNotNull(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	rule, err := CreatePricingRule(ctx, database, ptrTo(usdRuleIn("free-model", 0, 0, nil)))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO request_logs
        (created_at, method, path, client_type, model, request_model, status_code,
         total_tokens, cost_micros, cost_currency, pricing_rule_id)
        VALUES ('2026-06-01 10:00:00', 'POST', 'chat/completions', 'codex',
                'free-model', 'free-model', 200, 1000, 0, 'USD', ?)`,
		rule.ID); err != nil {
		t.Fatalf("insert: %v", err)
	}

	entries, err := ListLogs(ctx, database, 10, 0, nil, LogFilter{})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	free := entries[0]
	if free.CostMicros == nil {
		t.Fatal("cost_micros is nil for a zero-priced model; free is not unknown")
	}
	if *free.CostMicros != 0 {
		t.Errorf("cost_micros = %d, want 0", *free.CostMicros)
	}
	if free.PricingRuleID == nil {
		t.Error("pricing_rule_id is nil; a zero price is still a priced request")
	}
}

// TestInvalidPricingRulesAreRefusedByTheStore keeps the CHECK constraints and the
// validation in agreement, so a bad value cannot arrive by either route.
func TestInvalidPricingRulesAreRefusedByTheStore(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	for name, input := range map[string]models.PricingRuleIn{
		"negative price": usdRuleIn("gpt-4o", -1, 0, nil),
		"blank pattern":  usdRuleIn("   ", 1, 0, nil),
		"inner wildcard": usdRuleIn("gpt-*-turbo", 1, 0, nil),
		"bad currency": {ModelPattern: "gpt-4o", Currency: "EUR",
			PromptMicros: 1_000_000},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := CreatePricingRule(ctx, database, ptrTo(input)); err == nil {
				t.Errorf("%s was accepted", name)
			}
		})
	}

	// The database's own CHECK is the backstop for a write that bypasses
	// validation, which is what a hand-edited file or a future code path would do.
	if _, err := database.ExecContext(ctx, `INSERT INTO model_prices
        (model_pattern, currency, prompt_micros, completion_micros,
         cache_read_micros, cache_create_micros, effective_from)
        VALUES ('x', 'GBP', 1, 1, 1, 1, '2026-01-01 00:00:00')`); err == nil {
		t.Error("the currency CHECK did not refuse an unsupported code")
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO model_prices
        (model_pattern, currency, prompt_micros, completion_micros,
         cache_read_micros, cache_create_micros, effective_from)
        VALUES ('x', 'USD', -5, 1, 1, 1, '2026-01-01 00:00:00')`); err == nil {
		t.Error("the non-negative CHECK did not refuse a negative price")
	}
}

func ptrTo[T any](value T) *T { return &value }
