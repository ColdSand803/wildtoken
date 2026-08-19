package models

import "testing"

func int32Ptr(value int32) *int32 { return &value }

// usdRule builds a rule at the given per-million-token prices, expressed in
// whole currency units for readability.
func usdRule(id int64, pattern string, prompt, completion, cacheRead, cacheCreate float64,
	effectiveFrom string) PricingRule {
	// The test may write 2.5 for readability, but it converts to an exact integer
	// here. Nothing in the production path takes a float.
	toMicros := func(units float64) int64 { return int64(units * float64(MicroUnitsPerUnit)) }
	return PricingRule{
		ID:                id,
		ModelPattern:      pattern,
		Currency:          CurrencyUSD,
		PromptMicros:      toMicros(prompt),
		CompletionMicros:  toMicros(completion),
		CacheReadMicros:   toMicros(cacheRead),
		CacheCreateMicros: toMicros(cacheCreate),
		EffectiveFrom:     effectiveFrom,
	}
}

// TestCostIsDeterministicForTheSameUsageAndVersion is the completion standard:
// the same usage under the same price version must always give the same amount.
func TestCostIsDeterministicForTheSameUsageAndVersion(t *testing.T) {
	rule := usdRule(1, "gpt-4o", 2.5, 10, 1.25, 3.125, "2026-01-01 00:00:00")
	usage := RequestUsage{
		PromptTokens:     int32Ptr(1_000_000),
		CompletionTokens: int32Ptr(500_000),
	}

	first := CostMicros(rule, usage)
	for range 100 {
		if again := CostMicros(rule, usage); again != first {
			t.Fatalf("cost varied between calls: %d then %d", first, again)
		}
	}

	// 1M prompt at $2.50 + 500k completion at $10.00 = $2.50 + $5.00 = $7.50.
	if want := int64(7_500_000); first != want {
		t.Errorf("cost = %d micros, want %d ($7.50)", first, want)
	}
}

// TestCachedPromptTokensAreNotBilledTwice is the accounting rule that decides
// whether a cache-heavy caller's bill is right.
//
// Providers report cached tokens as a subset of prompt_tokens. Charging
// prompt_tokens in full and then adding the cache-read tokens bills the cached
// portion twice — once at the dear rate, once at the cheap one — which inflates
// exactly the case the cache exists to make cheaper.
func TestCachedPromptTokensAreNotBilledTwice(t *testing.T) {
	rule := usdRule(1, "gpt-4o", 10, 30, 1, 0, "2026-01-01 00:00:00")

	// 1M prompt tokens of which 900k were cache hits.
	cost := CostMicros(rule, RequestUsage{
		PromptTokens:       int32Ptr(1_000_000),
		PromptCachedTokens: int32Ptr(900_000),
	})

	// 100k fresh at $10/M = $1.00, plus 900k cached at $1/M = $0.90 → $1.90.
	if want := int64(1_900_000); cost != want {
		t.Errorf("cost = %d micros, want %d ($1.90): the cached portion is billed once, cheaply",
			cost, want)
	}

	// The double-billed figure, for contrast: $10.00 + $0.90 = $10.90. If the
	// implementation ever regresses to that, the assertion above fails — this one
	// just names the wrong answer so the intent is unmistakable.
	if cost == 10_900_000 {
		t.Error("the cached tokens were billed at both the prompt and the cache-read rate")
	}
}

// TestMoreCachedTokensThanPromptTokensDoesNotCreditTheCaller: a provider
// reporting an uninterpretable pair must not produce a negative charge.
func TestMoreCachedTokensThanPromptTokensDoesNotCreditTheCaller(t *testing.T) {
	rule := usdRule(1, "gpt-4o", 10, 30, 1, 0, "2026-01-01 00:00:00")

	cost := CostMicros(rule, RequestUsage{
		PromptTokens:       int32Ptr(1_000),
		PromptCachedTokens: int32Ptr(5_000),
	})
	if cost < 0 {
		t.Fatalf("cost = %d, want no negative charge", cost)
	}
	// The fresh portion floors at zero, so only the cached tokens are billed:
	// 5000 × $1/M = $0.005.
	if want := int64(5_000); cost != want {
		t.Errorf("cost = %d micros, want %d", cost, want)
	}
}

// TestCostRoundsHalfUpPerDimension pins the rounding rule, and pins it at the
// place it is applied.
//
// Rounding once at the end would leave a fractional remainder per dimension with
// no representation in the stored amount, so the total would not equal the sum of
// the four per-dimension figures the console shows beside it.
func TestCostRoundsHalfUpPerDimension(t *testing.T) {
	// A price of 1 micro per million tokens makes the sub-micro arithmetic visible.
	rule := PricingRule{
		ID: 1, ModelPattern: "tiny", Currency: CurrencyUSD,
		PromptMicros: 1, CompletionMicros: 1,
		EffectiveFrom: "2026-01-01 00:00:00",
	}

	for name, testCase := range map[string]struct {
		prompt int32
		want   int64
	}{
		"below half rounds down":   {prompt: 499_999, want: 0},
		"exactly half rounds up":   {prompt: 500_000, want: 1},
		"above half rounds up":     {prompt: 500_001, want: 1},
		"a whole unit is exact":    {prompt: 1_000_000, want: 1},
		"one and a half rounds up": {prompt: 1_500_000, want: 2},
	} {
		t.Run(name, func(t *testing.T) {
			got := CostMicros(rule, RequestUsage{PromptTokens: int32Ptr(testCase.prompt)})
			if got != testCase.want {
				t.Errorf("cost = %d micros, want %d", got, testCase.want)
			}
		})
	}
}

// TestZeroPricedDimensionsAreFreeNotUnknown keeps "free" distinct from "no rule".
func TestZeroPricedDimensionsAreFreeNotUnknown(t *testing.T) {
	rule := usdRule(1, "free-model", 0, 0, 0, 0, "2026-01-01 00:00:00")

	cost := CostMicros(rule, RequestUsage{
		PromptTokens:     int32Ptr(10_000_000),
		CompletionTokens: int32Ptr(10_000_000),
	})
	if cost != 0 {
		t.Errorf("cost = %d, want 0 for an all-zero price", cost)
	}

	// And a rule was in fact found, which is what separates this from an unpriced
	// model: the caller can report "$0.00" rather than "unknown".
	if _, ok := SelectPricingRule([]PricingRule{rule}, "free-model",
		"2026-06-01 00:00:00"); !ok {
		t.Error("no rule selected for a zero-priced model")
	}
}

// TestUnreportedUsageDimensionsContributeNothing: a provider that omits a
// dimension must not be billed as though it reported zero-cost usage or crash the
// settlement.
func TestUnreportedUsageDimensionsContributeNothing(t *testing.T) {
	rule := usdRule(1, "gpt-4o", 10, 30, 1, 5, "2026-01-01 00:00:00")

	// Only completion tokens reported.
	cost := CostMicros(rule, RequestUsage{CompletionTokens: int32Ptr(1_000_000)})
	if want := int64(30_000_000); cost != want {
		t.Errorf("cost = %d, want %d ($30.00)", cost, want)
	}

	// Nothing reported at all.
	if empty := CostMicros(rule, RequestUsage{}); empty != 0 {
		t.Errorf("cost = %d for no reported usage, want 0", empty)
	}
}

// TestARequestIsPricedByTheVersionInForceWhenItRan is what keeps a price edit
// from rewriting history.
func TestARequestIsPricedByTheVersionInForceWhenItRan(t *testing.T) {
	old := usdRule(1, "gpt-4o", 10, 30, 0, 0, "2026-01-01 00:00:00")
	raised := usdRule(2, "gpt-4o", 20, 60, 0, 0, "2026-06-01 00:00:00")
	rules := []PricingRule{old, raised}

	before, ok := SelectPricingRule(rules, "gpt-4o", "2026-03-15 12:00:00")
	if !ok || before.ID != 1 {
		t.Fatalf("selected rule %d for a March request, want the January version", before.ID)
	}
	after, ok := SelectPricingRule(rules, "gpt-4o", "2026-07-15 12:00:00")
	if !ok || after.ID != 2 {
		t.Fatalf("selected rule %d for a July request, want the June version", after.ID)
	}

	// A rule that is not yet effective must not price anything, so scheduling
	// tomorrow's price does not change today's bill.
	if _, ok := SelectPricingRule([]PricingRule{raised}, "gpt-4o",
		"2026-05-31 23:59:59"); ok {
		t.Error("a future rule priced a request that ran before it took effect")
	}
}

// TestAnExactRuleOutranksAWildcardThatAlsoMatches keeps the choice from depending
// on row order, which is what makes a catch-all default price safe to add.
func TestAnExactRuleOutranksAWildcardThatAlsoMatches(t *testing.T) {
	catchAll := usdRule(1, "*", 99, 99, 0, 0, "2026-01-01 00:00:00")
	broad := usdRule(2, "gpt-4o*", 20, 20, 0, 0, "2026-01-01 00:00:00")
	exact := usdRule(3, "gpt-4o-mini", 1, 1, 0, 0, "2026-01-01 00:00:00")

	// Every ordering must reach the same verdict.
	for _, rules := range [][]PricingRule{
		{catchAll, broad, exact},
		{exact, broad, catchAll},
		{broad, exact, catchAll},
	} {
		chosen, ok := SelectPricingRule(rules, "gpt-4o-mini", "2026-06-01 00:00:00")
		if !ok || chosen.ID != 3 {
			t.Errorf("selected rule %d, want the exact one regardless of order", chosen.ID)
		}
	}

	// The longer wildcard beats the shorter one for a model only they match.
	chosen, ok := SelectPricingRule([]PricingRule{catchAll, broad}, "gpt-4o-2024",
		"2026-06-01 00:00:00")
	if !ok || chosen.ID != 2 {
		t.Errorf("selected rule %d, want the more specific wildcard", chosen.ID)
	}
	// And the catch-all still prices a model nothing else names.
	chosen, ok = SelectPricingRule([]PricingRule{catchAll, broad}, "some-other-model",
		"2026-06-01 00:00:00")
	if !ok || chosen.ID != 1 {
		t.Errorf("selected rule %d, want the catch-all", chosen.ID)
	}
}

// TestPricingMatchIsNotFuzzyLikeChannelSelection: a rule for gpt-4o must not
// price gpt-4o-mini at the larger model's rate.
func TestPricingMatchIsNotFuzzyLikeChannelSelection(t *testing.T) {
	exact := usdRule(1, "gpt-4o", 10, 30, 0, 0, "2026-01-01 00:00:00")

	if _, ok := SelectPricingRule([]PricingRule{exact}, "gpt-4o-mini",
		"2026-06-01 00:00:00"); ok {
		t.Error("a rule for gpt-4o priced gpt-4o-mini; prefix matching overcharges")
	}
	if _, ok := SelectPricingRule([]PricingRule{exact}, "4o", "2026-06-01 00:00:00"); ok {
		t.Error("a rule for gpt-4o priced a suffix of its name")
	}
	// Case still folds, because that is a spelling difference and not a different
	// model.
	if _, ok := SelectPricingRule([]PricingRule{exact}, "GPT-4O",
		"2026-06-01 00:00:00"); !ok {
		t.Error("matching is case sensitive; it should fold case")
	}
}

// TestNoRuleIsDistinctFromAZeroPrice is the "estimated amount" boundary: an
// unpriced model has an unknown cost, and reporting it as $0.00 would understate
// a total.
func TestNoRuleIsDistinctFromAZeroPrice(t *testing.T) {
	rules := []PricingRule{usdRule(1, "gpt-4o", 10, 30, 0, 0, "2026-01-01 00:00:00")}

	if _, ok := SelectPricingRule(rules, "an-unpriced-model", "2026-06-01 00:00:00"); ok {
		t.Error("an unpriced model matched a rule")
	}
	if _, ok := SelectPricingRule(nil, "gpt-4o", "2026-06-01 00:00:00"); ok {
		t.Error("an empty price table priced a model")
	}
	// A blank model name matches nothing rather than falling into a catch-all: it
	// is not a model, and pricing it would attribute cost to no model at all.
	catchAll := []PricingRule{usdRule(1, "*", 1, 1, 0, 0, "2026-01-01 00:00:00")}
	if _, ok := SelectPricingRule(catchAll, "", "2026-06-01 00:00:00"); ok {
		t.Error("a blank model name matched the catch-all rule")
	}
}

// TestFormatMicrosAgreesWithTheStoredInteger keeps the displayed string and the
// stored amount from disagreeing.
func TestFormatMicrosAgreesWithTheStoredInteger(t *testing.T) {
	for name, testCase := range map[string]struct {
		micros   int64
		currency string
		want     string
	}{
		"whole dollars":  {7_500_000, CurrencyUSD, "$7.50"},
		"zero":           {0, CurrencyUSD, "$0.00"},
		"yuan":           {1_234_500, CurrencyCNY, "¥1.23"},
		"rounds half up": {1_235_000, CurrencyUSD, "$1.24"},
		"large amount":   {123_456_789_000, CurrencyUSD, "$123456.79"},
		// A per-request cost is often a fraction of a cent. Showing it as $0.00
		// is how a real total comes to look free, so small amounts get more digits.
		"sub-cent stays visible": {5_000, CurrencyUSD, "$0.005000"},
		"one micro":              {1, CurrencyUSD, "$0.000001"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := FormatMicros(testCase.micros, testCase.currency); got != testCase.want {
				t.Errorf("FormatMicros(%d, %s) = %q, want %q",
					testCase.micros, testCase.currency, got, testCase.want)
			}
		})
	}
}

// TestPricingRuleValidationRefusesWhatItCannotStoreFaithfully covers the write
// path's bounds.
func TestPricingRuleValidationRefusesWhatItCannotStoreFaithfully(t *testing.T) {
	valid := func() PricingRuleIn {
		return PricingRuleIn{ModelPattern: "gpt-4o", Currency: "usd",
			PromptMicros: 2_500_000, CompletionMicros: 10_000_000}
	}

	// A lowercase currency is normalized rather than refused.
	input := valid()
	if err := input.Validate(); err != nil {
		t.Fatalf("a valid rule was refused: %v", err)
	}
	if input.Currency != CurrencyUSD {
		t.Errorf("currency = %q, want it normalized to USD", input.Currency)
	}
	// An absent effective_from resolves to now, which is what entering today's
	// price means.
	if input.NormalizedEffectiveFrom() == "" {
		t.Error("an absent effective_from did not resolve to a timestamp")
	}

	for name, mutate := range map[string]func(*PricingRuleIn){
		"blank pattern":     func(p *PricingRuleIn) { p.ModelPattern = "  " },
		"inner wildcard":    func(p *PricingRuleIn) { p.ModelPattern = "gpt-*-turbo" },
		"control character": func(p *PricingRuleIn) { p.ModelPattern = "gpt\x004o" },
		"unknown currency":  func(p *PricingRuleIn) { p.Currency = "EUR" },
		"negative price":    func(p *PricingRuleIn) { p.PromptMicros = -1 },
		"absurd price":      func(p *PricingRuleIn) { p.PromptMicros = PricingMaxUnitPrice + 1 },
		"bad timestamp": func(p *PricingRuleIn) {
			bad := "not-a-time"
			p.EffectiveFrom = &bad
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := valid()
			mutate(&input)
			if err := input.Validate(); err == nil {
				t.Errorf("%s was accepted", name)
			}
		})
	}
}

// TestCostCannotOverflowAtTheValidatedCeiling checks the bound the price cap
// exists for: an int32 token count at the maximum price must stay in int64.
func TestCostCannotOverflowAtTheValidatedCeiling(t *testing.T) {
	rule := PricingRule{
		ID: 1, ModelPattern: "*", Currency: CurrencyUSD,
		PromptMicros:      PricingMaxUnitPrice,
		CompletionMicros:  PricingMaxUnitPrice,
		CacheReadMicros:   PricingMaxUnitPrice,
		CacheCreateMicros: PricingMaxUnitPrice,
		EffectiveFrom:     "2026-01-01 00:00:00",
	}
	maxTokens := int32(1<<31 - 1)

	cost := CostMicros(rule, RequestUsage{
		PromptTokens:        int32Ptr(maxTokens),
		CompletionTokens:    int32Ptr(maxTokens),
		CacheCreationTokens: int32Ptr(maxTokens),
	})
	if cost <= 0 {
		t.Fatalf("cost = %d at the ceiling, want a positive amount (overflow)", cost)
	}
}
