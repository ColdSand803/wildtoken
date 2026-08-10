package models

import (
	"fmt"
	"strconv"
	"strings"
)

// QuotaMaxTokens caps a stored limit. SQLite holds an int64, and a limit beyond
// this is indistinguishable from "unlimited" in practice while risking overflow
// in the arithmetic below.
const QuotaMaxTokens int64 = 1 << 62

// quotaUnits maps a suffix onto its multiplier.
//
// These are powers of 1000, not 1024: a token limit is a counted quantity the
// operator reasons about in decimal, so 1M means one million tokens.
var quotaUnits = map[string]int64{
	"":  1,
	"K": 1_000,
	"M": 1_000_000,
	"B": 1_000_000_000,
	"T": 1_000_000_000_000,
}

// ParseQuotaExpression reads a token limit such as 100M, 1B, 1000K or 250000.
//
// An empty value means no limit and is reported as nil, so clearing the console
// field removes the limit rather than setting it to zero.
func ParseQuotaExpression(raw string) (*int64, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, nil
	}

	// The suffix is case-insensitive so both 100m and 100M work, which is what
	// operators type in practice.
	upper := strings.ToUpper(value)
	unit := ""
	if last := upper[len(upper)-1]; last < '0' || last > '9' {
		unit = string(last)
		upper = upper[:len(upper)-1]
	}

	multiplier, ok := quotaUnits[unit]
	if !ok {
		return nil, ErrString("limit unit must be one of K, M, B, T")
	}
	if upper == "" {
		return nil, ErrString("limit must start with a number, for example 100M")
	}

	// Only digits and a single decimal point are allowed. ParseFloat would also
	// take forms like 1e9, +5 and Inf, none of which an operator means as a
	// token limit, and an inner space would let "100 M" pass as two values.
	if !isPlainDecimal(upper) {
		return nil, ErrString("limit must be a number optionally followed by K, M, B or T")
	}

	// A decimal like 1.5M is accepted, because a limit is a rounded quantity and
	// refusing it would be a needless obstacle.
	amount, err := strconv.ParseFloat(upper, 64)
	if err != nil {
		return nil, ErrString("limit must be a number optionally followed by K, M, B or T")
	}
	if amount < 0 {
		return nil, ErrString("limit must not be negative")
	}

	scaled := amount * float64(multiplier)
	if scaled > float64(QuotaMaxTokens) {
		return nil, ErrString("limit is too large")
	}
	// A limit that rounds down to zero would block every request, which no
	// operator means by typing a number.
	limit := int64(scaled)
	if limit <= 0 {
		return nil, ErrString("limit must be at least 1 token")
	}
	return &limit, nil
}

// FormatQuota renders a stored limit back into the shortest exact expression, so
// the console shows what the operator typed rather than a raw digit count.
//
// A value that is not a whole multiple of a unit keeps one decimal place; if
// even that would lose precision, the exact number is returned.
func FormatQuota(limit *int64) string {
	if limit == nil {
		return ""
	}
	value := *limit

	for _, unit := range []struct {
		suffix     string
		multiplier int64
	}{
		{"T", 1_000_000_000_000},
		{"B", 1_000_000_000},
		{"M", 1_000_000},
		{"K", 1_000},
	} {
		if value < unit.multiplier {
			continue
		}
		if value%unit.multiplier == 0 {
			return strconv.FormatInt(value/unit.multiplier, 10) + unit.suffix
		}
		// One decimal place, but only when it is exact.
		tenths := value * 10 / unit.multiplier
		if tenths*unit.multiplier == value*10 {
			return strconv.FormatFloat(float64(tenths)/10, 'f', -1, 64) + unit.suffix
		}
		break
	}
	return strconv.FormatInt(value, 10)
}

// QuotaState is what the console shows for one token's limit.
type QuotaState struct {
	// UsedTokens is the running total, which survives log retention because it
	// is maintained on the token row rather than aggregated from request logs.
	UsedTokens int64 `json:"used_tokens"`
	// LimitTokens is nil when the token is unlimited.
	LimitTokens *int64 `json:"limit_tokens"`
	// LimitExpression is the shortest exact rendering of LimitTokens.
	LimitExpression string `json:"limit_expression"`
	// RemainingTokens is nil when unlimited, and floored at zero when the last
	// request was allowed to overshoot the limit.
	RemainingTokens *int64 `json:"remaining_tokens"`
	// Exhausted reports whether further requests are refused.
	Exhausted bool `json:"exhausted"`
}

// NewQuotaState derives the reported state from the stored counters.
func NewQuotaState(usedTokens int64, limitTokens *int64) QuotaState {
	state := QuotaState{
		UsedTokens:      usedTokens,
		LimitTokens:     limitTokens,
		LimitExpression: FormatQuota(limitTokens),
	}
	if limitTokens == nil {
		return state
	}

	remaining := *limitTokens - usedTokens
	if remaining < 0 {
		// The final request is allowed to overshoot, because the cost of a
		// request is only known after it completes. Remaining is reported as
		// zero rather than negative.
		remaining = 0
	}
	state.RemainingTokens = &remaining
	state.Exhausted = usedTokens >= *limitTokens
	return state
}

// QuotaExceededMessage explains a refusal to the downstream caller.
func QuotaExceededMessage(usedTokens int64, limitTokens int64) string {
	return fmt.Sprintf("token quota exhausted: %s of %s tokens used",
		FormatQuota(&usedTokens), FormatQuota(&limitTokens))
}

// isPlainDecimal reports whether a string is only digits with at most one
// decimal point, which is the whole of what a token limit may look like.
func isPlainDecimal(value string) bool {
	seenPoint := false
	seenDigit := false
	for _, character := range value {
		switch {
		case character >= '0' && character <= '9':
			seenDigit = true
		case character == '.':
			if seenPoint {
				return false
			}
			seenPoint = true
		default:
			return false
		}
	}
	return seenDigit
}
