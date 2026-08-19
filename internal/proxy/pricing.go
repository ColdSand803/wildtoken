package proxy

import (
	"sync"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// PricingBook holds the price table in memory for the settlement path.
//
// Settlement runs once per completed request, on the same goroutine that enqueues
// the log row. Reading SQLite there would put a query on the tail of every
// request, and the price table is small, rarely written and read constantly —
// which is the same shape as the runtime settings store, so it is cached the same
// way: written only by the admin console, copied out on read.
//
// It lives here rather than in appstate because the log writer holds it, and
// appstate imports this package.
type PricingBook struct {
	mu    sync.RWMutex
	rules []models.PricingRule
	// now is swappable so tests can price a request at a chosen instant without
	// waiting, matching AutoWeightManager and LatencyTracker.
	now func() time.Time
}

func NewPricingBook() *PricingBook {
	return &PricingBook{now: time.Now}
}

// Replace swaps the whole table, which is what an admin write produces.
//
// Wholesale rather than incremental: the table is the unit the console edits, and
// a partial update would leave the settlement path briefly reading a mix of two
// versions of the price sheet.
func (b *PricingBook) Replace(rules []models.PricingRule) {
	if b == nil {
		return
	}
	copied := make([]models.PricingRule, len(rules))
	copy(copied, rules)

	b.mu.Lock()
	defer b.mu.Unlock()
	b.rules = copied
}

// Rules returns a copy of the table, for the console.
func (b *PricingBook) Rules() []models.PricingRule {
	if b == nil {
		return nil
	}
	b.mu.RLock()
	defer b.mu.RUnlock()

	copied := make([]models.PricingRule, len(b.rules))
	copy(copied, b.rules)
	return copied
}

// Settle prices one request's usage, returning the snapshot to store.
//
// The instant used is now, meaning the moment the request finished and its usage
// became known — not the moment the log row is written. Those differ by however
// long the batch queue is, and pricing by the write time would let a price edit
// landing in that window change what an already-served request cost.
//
// A nil snapshot means no rule covered the model, which is "cost unknown" and is
// deliberately distinct from a rule pricing it at zero. A nil book behaves the
// same way, so a caller assembled without one — a test harness, a probe — needs no
// guard at the call site.
func (b *PricingBook) Settle(model *string, usage models.RequestUsage) *models.CostSnapshot {
	if b == nil || model == nil {
		return nil
	}

	b.mu.RLock()
	rules := b.rules
	at := b.now().UTC().Format(models.TimestampFormat)
	b.mu.RUnlock()

	if len(rules) == 0 {
		return nil
	}
	rule, ok := models.SelectPricingRule(rules, *model, at)
	if !ok {
		return nil
	}
	return &models.CostSnapshot{
		PricingRuleID: rule.ID,
		Currency:      rule.Currency,
		TotalMicros:   models.CostMicros(rule, usage),
	}
}
