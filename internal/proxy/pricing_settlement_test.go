package proxy

import (
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// bookAt returns a book whose clock is fixed, so a request can be priced at a
// chosen instant without waiting.
func bookAt(instant string, rules ...models.PricingRule) *PricingBook {
	book := NewPricingBook()
	parsed, err := time.Parse(models.TimestampFormat, instant)
	if err != nil {
		panic(err)
	}
	book.now = func() time.Time { return parsed }
	book.Replace(rules)
	return book
}

func priceRule(id int64, pattern string, promptMicros, completionMicros int64,
	effectiveFrom string) models.PricingRule {
	return models.PricingRule{
		ID: id, ModelPattern: pattern, Currency: models.CurrencyUSD,
		PromptMicros: promptMicros, CompletionMicros: completionMicros,
		EffectiveFrom: effectiveFrom,
	}
}

func int32Ptr(value int32) *int32 { return &value }

// TestSettlementStoresTheVersionAlongsideTheAmount is the whole point of the
// snapshot: a figure that cannot be traced to a price version cannot be explained.
func TestSettlementStoresTheVersionAlongsideTheAmount(t *testing.T) {
	book := bookAt("2026-06-01 12:00:00",
		priceRule(7, "gpt-4o", 2_500_000, 10_000_000, "2026-01-01 00:00:00"))

	model := "gpt-4o"
	cost := book.Settle(&model, models.RequestUsage{
		PromptTokens:     int32Ptr(1_000_000),
		CompletionTokens: int32Ptr(100_000),
	})
	if cost == nil {
		t.Fatal("no cost snapshot for a priced model")
	}
	if cost.PricingRuleID != 7 {
		t.Errorf("pricing_rule_id = %d, want 7", cost.PricingRuleID)
	}
	if cost.Currency != models.CurrencyUSD {
		t.Errorf("currency = %q, want USD", cost.Currency)
	}
	// $2.50 + $1.00 = $3.50.
	if want := int64(3_500_000); cost.TotalMicros != want {
		t.Errorf("total = %d micros, want %d", cost.TotalMicros, want)
	}
}

// TestAnUnpricedModelSettlesToNothing keeps "unknown" out of the totals.
//
// Storing zero would make an unpriced model look free, and a dashboard summing the
// column would report a total that silently excludes real spending.
func TestAnUnpricedModelSettlesToNothing(t *testing.T) {
	book := bookAt("2026-06-01 12:00:00",
		priceRule(1, "gpt-4o", 2_500_000, 10_000_000, "2026-01-01 00:00:00"))

	unpriced := "some-other-model"
	if cost := book.Settle(&unpriced, models.RequestUsage{
		PromptTokens: int32Ptr(1_000_000)}); cost != nil {
		t.Errorf("cost = %+v for an unpriced model, want nil", cost)
	}

	// A request with no model at all, which is what a non-chat route produces.
	if cost := book.Settle(nil, models.RequestUsage{
		PromptTokens: int32Ptr(1_000)}); cost != nil {
		t.Errorf("cost = %+v for a request with no model, want nil", cost)
	}

	// An empty table prices nothing, which is the state before an operator has
	// entered any prices.
	empty := bookAt("2026-06-01 12:00:00")
	model := "gpt-4o"
	if cost := empty.Settle(&model, models.RequestUsage{
		PromptTokens: int32Ptr(1_000)}); cost != nil {
		t.Errorf("cost = %+v from an empty table, want nil", cost)
	}
}

// TestANilBookIsSafe so a harness or probe assembled without pricing needs no
// guard at the call site.
func TestANilBookIsSafe(t *testing.T) {
	var book *PricingBook
	model := "gpt-4o"
	if cost := book.Settle(&model, models.RequestUsage{
		PromptTokens: int32Ptr(1_000)}); cost != nil {
		t.Errorf("cost = %+v from a nil book, want nil", cost)
	}
	book.Replace([]models.PricingRule{priceRule(1, "*", 1, 1, "2026-01-01 00:00:00")})
	if rules := book.Rules(); rules != nil {
		t.Errorf("rules = %v from a nil book, want nil", rules)
	}
}

// TestARaisedPriceDoesNotChangeAnAlreadySettledAmount is the completion standard
// spelled out: settle, then edit the table, then check the first amount is intact.
func TestARaisedPriceDoesNotChangeAnAlreadySettledAmount(t *testing.T) {
	book := bookAt("2026-06-01 12:00:00",
		priceRule(1, "gpt-4o", 2_000_000, 0, "2026-01-01 00:00:00"))

	model := "gpt-4o"
	usage := models.RequestUsage{PromptTokens: int32Ptr(1_000_000)}

	before := book.Settle(&model, usage)
	if before == nil || before.TotalMicros != 2_000_000 {
		t.Fatalf("first settlement = %+v, want $2.00", before)
	}

	// The operator doubles the price, effective earlier than the request even —
	// the harshest case, since it would retroactively reprice if the amount were
	// recomputed on read rather than stored.
	book.Replace([]models.PricingRule{
		priceRule(1, "gpt-4o", 2_000_000, 0, "2026-01-01 00:00:00"),
		priceRule(2, "gpt-4o", 4_000_000, 0, "2026-02-01 00:00:00"),
	})

	if before.TotalMicros != 2_000_000 {
		t.Errorf("the stored amount changed to %d after a price edit", before.TotalMicros)
	}
	if before.PricingRuleID != 1 {
		t.Errorf("the stored version changed to %d after a price edit", before.PricingRuleID)
	}

	// A request settling now does get the new price, which is the other half of
	// the requirement.
	after := book.Settle(&model, usage)
	if after == nil || after.TotalMicros != 4_000_000 {
		t.Fatalf("second settlement = %+v, want $4.00 under the new version", after)
	}
	if after.PricingRuleID != 2 {
		t.Errorf("pricing_rule_id = %d, want the new version", after.PricingRuleID)
	}
}

// TestSettlementPricesByTheVersionEffectiveAtTheRequestsInstant: the book's clock
// decides, and a version scheduled for the future must not price today.
func TestSettlementPricesByTheVersionEffectiveAtTheRequestsInstant(t *testing.T) {
	rules := []models.PricingRule{
		priceRule(1, "gpt-4o", 2_000_000, 0, "2026-01-01 00:00:00"),
		priceRule(2, "gpt-4o", 4_000_000, 0, "2026-07-01 00:00:00"),
	}
	model := "gpt-4o"
	usage := models.RequestUsage{PromptTokens: int32Ptr(1_000_000)}

	// A request in June is priced by the January version, even though a July
	// version already exists in the table.
	june := bookAt("2026-06-15 09:00:00", rules...)
	if cost := june.Settle(&model, usage); cost == nil || cost.PricingRuleID != 1 {
		t.Fatalf("June settlement used version %+v, want the January one", cost)
	}
	// The same table, a later request.
	july := bookAt("2026-07-15 09:00:00", rules...)
	if cost := july.Settle(&model, usage); cost == nil || cost.PricingRuleID != 2 {
		t.Fatalf("July settlement used version %+v, want the July one", cost)
	}
}

// TestConcurrentSettlementAndReplaceDoNotRace exercises the lock, since the
// settlement path runs on request goroutines while the console replaces the table.
func TestConcurrentSettlementAndReplaceDoNotRace(t *testing.T) {
	book := bookAt("2026-06-01 12:00:00",
		priceRule(1, "gpt-4o", 1_000_000, 0, "2026-01-01 00:00:00"))
	model := "gpt-4o"

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 200 {
			book.Replace([]models.PricingRule{
				priceRule(int64(i%5+1), "gpt-4o", int64(i+1)*1_000, 0, "2026-01-01 00:00:00"),
			})
		}
	}()
	for range 200 {
		// The only requirement is that every settlement produces a coherent
		// snapshot: an amount from one version, never a mix of two.
		if cost := book.Settle(&model, models.RequestUsage{
			PromptTokens: int32Ptr(1_000_000)}); cost != nil && cost.PricingRuleID == 0 {
			t.Error("settled against a rule with no id")
		}
	}
	<-done
}
