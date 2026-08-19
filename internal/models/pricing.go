package models

import (
	"strings"
	"unicode/utf8"
)

// Money in this package is always an integer count of micro-units of the
// currency's major unit: 1_000_000 micro-USD is one dollar. Nothing here uses
// float64, and that is the point.
//
// A binary float cannot represent 0.1 exactly, so accumulating a bill in float64
// drifts — invisibly at first, then as a total that does not equal the sum of the
// rows it came from. Prices are also quoted per million tokens at values like
// $2.50, which is 2_500_000 micro-USD: exact as an integer, inexact as a float.
const (
	// MicroUnitsPerUnit is how many micro-units make one major unit of currency.
	MicroUnitsPerUnit int64 = 1_000_000
	// PricingTokenBasis is the token count a stored unit price is quoted per.
	// Providers publish per-million-token prices, so storing them that way keeps
	// the stored number the one an operator can check against a price sheet.
	PricingTokenBasis int64 = 1_000_000
)

// Supported currencies. The set is closed because a total is only meaningful
// summed within one currency, and the console has to label it.
const (
	CurrencyUSD = "USD"
	CurrencyCNY = "CNY"
)

// ValidCurrency reports whether a code is one this service can price in.
func ValidCurrency(code string) bool {
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case CurrencyUSD, CurrencyCNY:
		return true
	default:
		return false
	}
}

const (
	// PricingModelPatternMaxChars bounds a rule's match pattern.
	PricingModelPatternMaxChars = 200
	// PricingMaxUnitPrice caps one stored unit price, in micro-units per million
	// tokens. This is $1,000,000 per million tokens — far past any real price,
	// and low enough that a request's cost cannot overflow int64.
	PricingMaxUnitPrice int64 = 1_000_000 * MicroUnitsPerUnit
)

// PricingRule is one version of one model's price.
//
// Rules are versioned rather than edited in place: a request's cost is settled
// against the version in force when it ran, and that row keeps naming the version
// it used. Editing a price therefore writes a new version and leaves history
// alone, which is what keeps a bill from being retroactively rewritten.
type PricingRule struct {
	ID int64 `json:"id"`
	// ModelPattern matches the request's model, exactly or by trailing wildcard.
	// The same matching this service's model whitelist uses — see
	// AllowedModelsPolicy.Permits for why it is not the fuzzier channel matcher.
	ModelPattern string `json:"model_pattern"`
	Currency     string `json:"currency"`
	// The four unit prices, each in micro-units per PricingTokenBasis tokens.
	// Cache reads are usually cheaper than fresh prompt tokens and cache creation
	// usually dearer, so they are priced separately rather than derived.
	PromptMicros      int64 `json:"prompt_micros"`
	CompletionMicros  int64 `json:"completion_micros"`
	CacheReadMicros   int64 `json:"cache_read_micros"`
	CacheCreateMicros int64 `json:"cache_create_micros"`
	// EffectiveFrom is when this version began to apply, in TimestampFormat UTC.
	// A request is priced by the newest rule effective at or before it ran.
	EffectiveFrom string `json:"effective_from"`
	CreatedAt     string `json:"created_at"`
}

// PricingTableOut is what the console reads.
//
// The unit conventions travel with the data rather than being duplicated in the
// console: a client dividing by the wrong basis shows a price a million times off,
// with nothing to indicate which side is wrong.
type PricingTableOut struct {
	Rules []PricingRule `json:"rules"`
	// Basis is the token count a unit price is quoted per.
	Basis int64 `json:"token_basis"`
	// MicroUnitsPerUnit is how many stored micro-units make one major unit.
	MicroUnitsPerUnit int64 `json:"micro_units_per_unit"`
	// Currencies is the closed set a rule may name.
	Currencies []string `json:"currencies"`
}

// PricingRuleIn is the create payload.
type PricingRuleIn struct {
	ModelPattern      string `json:"model_pattern"`
	Currency          string `json:"currency"`
	PromptMicros      int64  `json:"prompt_micros"`
	CompletionMicros  int64  `json:"completion_micros"`
	CacheReadMicros   int64  `json:"cache_read_micros"`
	CacheCreateMicros int64  `json:"cache_create_micros"`
	// EffectiveFrom absent or blank means "now", which is what an operator
	// entering today's price means. A future value schedules a change.
	EffectiveFrom *string `json:"effective_from"`
}

// Validate judges a submitted rule and writes normalized values back.
func (p *PricingRuleIn) Validate() error {
	pattern := strings.TrimSpace(p.ModelPattern)
	if pattern == "" || utf8.RuneCountInString(pattern) > PricingModelPatternMaxChars {
		return ErrString("model_pattern must be between 1 and 200 characters")
	}
	if strings.ContainsFunc(pattern, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return ErrString("model_pattern must not contain control characters")
	}
	// Same rule as the whitelist: a wildcard is only supported at the end, and
	// storing an inner one would look like a rule while matching nothing.
	if inner := strings.TrimSuffix(pattern, "*"); strings.Contains(inner, "*") {
		return ErrString("a wildcard is only supported as a trailing * , for example gpt-4o-*")
	}
	p.ModelPattern = pattern

	if !ValidCurrency(p.Currency) {
		return ErrString("currency must be USD or CNY")
	}
	p.Currency = strings.ToUpper(strings.TrimSpace(p.Currency))

	for _, price := range []struct {
		name  string
		value int64
	}{
		{"prompt_micros", p.PromptMicros},
		{"completion_micros", p.CompletionMicros},
		{"cache_read_micros", p.CacheReadMicros},
		{"cache_create_micros", p.CacheCreateMicros},
	} {
		// Zero is allowed: a free tier, or a dimension a provider does not bill.
		// It is distinct from "no rule", which is what an absent rule means.
		if price.value < 0 {
			return ErrString(price.name + " must not be negative")
		}
		if price.value > PricingMaxUnitPrice {
			return ErrString(price.name + " is too large")
		}
	}

	normalized, err := NormalizeExpiresAt(p.EffectiveFrom)
	if err != nil {
		return ErrString(
			"effective_from must be an RFC 3339 timestamp or 'YYYY-MM-DD HH:MM:SS' in UTC")
	}
	p.EffectiveFrom = normalized
	return nil
}

// NormalizedEffectiveFrom resolves an absent value to now.
func (p *PricingRuleIn) NormalizedEffectiveFrom() string {
	if p.EffectiveFrom == nil || strings.TrimSpace(*p.EffectiveFrom) == "" {
		return UTCNowTimestamp()
	}
	return *p.EffectiveFrom
}

// MatchesModel reports whether this rule prices the given model.
//
// Exact case-insensitive equality or an explicit trailing wildcard, matching the
// model whitelist rather than the channel matcher. The fuzzy prefix/suffix
// matching that picks a channel would let a rule for "gpt-4o" price "gpt-4o-mini"
// at the larger model's rate.
func (p PricingRule) MatchesModel(model string) bool {
	candidate := strings.ToLower(strings.TrimSpace(model))
	if candidate == "" {
		return false
	}
	pattern := strings.ToLower(strings.TrimSpace(p.ModelPattern))
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(candidate, strings.TrimSuffix(pattern, "*"))
	}
	return candidate == pattern
}

// patternSpecificity ranks how narrowly a rule names a model, so an exact rule
// beats a wildcard that also matches.
//
// Without this, a catch-all "*" added for a default price would compete with
// every specific rule and the winner would depend on row order — a price sheet
// that changes meaning when a row is edited.
func (p PricingRule) patternSpecificity() int {
	pattern := strings.TrimSpace(p.ModelPattern)
	if !strings.HasSuffix(pattern, "*") {
		// An exact rule is the most specific thing there is, and outranks the
		// longest possible wildcard.
		return 1 << 20
	}
	return len(strings.TrimSuffix(pattern, "*"))
}

// SelectPricingRule picks the rule that prices a request.
//
// Rules are filtered to those matching the model and already effective at the
// moment the request ran, then ranked: most specific pattern first, and among
// equally specific patterns the newest effective_from. Ties beyond that go to the
// higher id, so the choice is total and does not depend on scan order.
//
// A request is priced by what was in force when it ran, not by what is in force
// now. That is what makes a stored amount explicable months later, and it is why
// `at` is a parameter rather than time.Now().
//
// Returns false when no rule prices the model, which is distinct from a rule
// pricing it at zero: the first means "unknown cost", the second "free".
func SelectPricingRule(rules []PricingRule, model, at string) (PricingRule, bool) {
	var best PricingRule
	found := false

	for _, rule := range rules {
		if !rule.MatchesModel(model) {
			continue
		}
		// String comparison: both sides are the same fixed-width UTC shape, so
		// lexical order is chronological order. Parsing here would open a window
		// where the console and the settlement path disagree about which version
		// was in force.
		if rule.EffectiveFrom > at {
			continue
		}
		if !found || rulePrecedes(best, rule) {
			best, found = rule, true
		}
	}
	return best, found
}

// rulePrecedes reports whether challenger should win over incumbent.
func rulePrecedes(incumbent, challenger PricingRule) bool {
	incumbentRank, challengerRank := incumbent.patternSpecificity(), challenger.patternSpecificity()
	if challengerRank != incumbentRank {
		return challengerRank > incumbentRank
	}
	if challenger.EffectiveFrom != incumbent.EffectiveFrom {
		return challenger.EffectiveFrom > incumbent.EffectiveFrom
	}
	return challenger.ID > incumbent.ID
}

// RequestUsage is the token counts one request consumed, as the log row holds
// them. Nil means the provider did not report that dimension.
type RequestUsage struct {
	PromptTokens        *int32
	CompletionTokens    *int32
	PromptCachedTokens  *int32
	CacheCreationTokens *int32
}

// CostSnapshot is what a settled request stores about its price.
//
// It is a snapshot rather than a reference: the amount is fixed here, so a later
// price edit cannot change what this request cost. The version id travels with it
// so the figure can be explained.
type CostSnapshot struct {
	// PricingRuleID names the version this amount was computed from.
	PricingRuleID int64
	Currency      string
	// TotalMicros is the whole cost in micro-units, always exact.
	TotalMicros int64
}

// billableTokens splits prompt tokens into the portions billed at each rate.
//
// Providers report cached tokens as a subset of prompt_tokens, not in addition to
// it. Billing prompt_tokens at the full rate and then adding the cache-read
// tokens on top would charge the cached portion twice — once dear, once cheap —
// which inflates every bill for a cache-heavy caller, the exact case the cache
// exists to make cheaper.
//
// The subtraction is floored at zero: a provider reporting more cached tokens
// than prompt tokens is reporting something this cannot interpret, and a negative
// count would credit the caller.
func billableTokens(usage RequestUsage) (freshPrompt, cachedPrompt, completion, cacheCreate int64) {
	prompt := int64PtrValue(usage.PromptTokens)
	cachedPrompt = int64PtrValue(usage.PromptCachedTokens)
	completion = int64PtrValue(usage.CompletionTokens)
	cacheCreate = int64PtrValue(usage.CacheCreationTokens)

	freshPrompt = prompt - cachedPrompt
	if freshPrompt < 0 {
		freshPrompt = 0
	}
	return freshPrompt, cachedPrompt, completion, cacheCreate
}

func int64PtrValue(value *int32) int64 {
	if value == nil || *value < 0 {
		return 0
	}
	return int64(*value)
}

// CostMicros computes one request's cost under a rule, in micro-units.
//
// Every step is integer arithmetic. Each dimension is (tokens × unit price)
// divided by the basis, rounded half up, and the four are then summed. Rounding
// per dimension rather than once at the end is deliberate: the alternative keeps
// a fractional remainder per dimension that has no representation in the stored
// amount, so the total would not equal the sum of the four figures the console
// displays beside it.
//
// Half up rather than banker's rounding because it is the rule an operator
// checking a figure by hand will apply.
func CostMicros(rule PricingRule, usage RequestUsage) int64 {
	freshPrompt, cachedPrompt, completion, cacheCreate := billableTokens(usage)

	return dimensionCost(freshPrompt, rule.PromptMicros) +
		dimensionCost(cachedPrompt, rule.CacheReadMicros) +
		dimensionCost(completion, rule.CompletionMicros) +
		dimensionCost(cacheCreate, rule.CacheCreateMicros)
}

// dimensionCost is tokens × unitPrice ÷ basis, rounded half up.
//
// The multiplication is bounded by the validated price ceiling and the int32
// token counts the log holds, so it cannot overflow int64.
func dimensionCost(tokens, unitPriceMicros int64) int64 {
	if tokens <= 0 || unitPriceMicros <= 0 {
		return 0
	}
	product := tokens * unitPriceMicros
	return (product + PricingTokenBasis/2) / PricingTokenBasis
}

// FormatMicros renders an amount for display, with two decimal places by default
// and more when the amount is small enough that two would show zero.
//
// Built by integer division rather than by dividing into a float: the console
// shows this string beside a stored integer, and the two must agree exactly.
func FormatMicros(micros int64, currency string) string {
	symbol := ""
	switch strings.ToUpper(currency) {
	case CurrencyUSD:
		symbol = "$"
	case CurrencyCNY:
		symbol = "¥"
	}

	negative := micros < 0
	if negative {
		micros = -micros
	}
	whole := micros / MicroUnitsPerUnit
	fraction := micros % MicroUnitsPerUnit

	// Two decimals unless that would render a non-zero amount as zero, in which
	// case enough digits are shown to make it visible: a per-request cost is often
	// a fraction of a cent, and displaying it as "$0.00" is how a real total comes
	// to look free.
	digits := 2
	if whole == 0 && fraction > 0 && fraction < 10_000 {
		digits = 6
	}

	scale := int64(1)
	for range digits {
		scale *= 10
	}
	scaled := (fraction*scale + MicroUnitsPerUnit/2) / MicroUnitsPerUnit
	if scaled >= scale {
		// Rounding carried into the whole part.
		whole++
		scaled = 0
	}

	out := strings.Builder{}
	if negative {
		out.WriteString("-")
	}
	out.WriteString(symbol)
	out.WriteString(formatInt(whole))
	out.WriteString(".")
	out.WriteString(padLeft(formatInt(scaled), digits))
	return out.String()
}

func formatInt(value int64) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 20)
	for value > 0 {
		digits = append(digits, byte('0'+value%10))
		value /= 10
	}
	for left, right := 0, len(digits)-1; left < right; left, right = left+1, right-1 {
		digits[left], digits[right] = digits[right], digits[left]
	}
	return string(digits)
}

func padLeft(value string, width int) string {
	if len(value) >= width {
		return value
	}
	return strings.Repeat("0", width-len(value)) + value
}
