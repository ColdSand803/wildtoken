package models

import (
	"strings"
	"time"
)

// Quota reset cycles. A token's limit either never resets, or resets on one of
// these boundaries.
const (
	// QuotaPeriodNone is the existing behaviour: the limit is a lifetime total and
	// only an operator clears it. This is the default, so an upgraded database
	// keeps behaving exactly as it did.
	QuotaPeriodNone = "none"
	// QuotaPeriodDaily resets at midnight in the token's timezone.
	QuotaPeriodDaily = "daily"
	// QuotaPeriodWeekly resets at Monday midnight, matching ISO week numbering.
	QuotaPeriodWeekly = "weekly"
	// QuotaPeriodMonthly resets at midnight on the first of the month.
	QuotaPeriodMonthly = "monthly"
)

// DefaultQuotaPeriod keeps an upgraded database resetting exactly as it did:
// never.
const DefaultQuotaPeriod = QuotaPeriodNone

// ValidQuotaPeriod reports whether a stored or submitted value names a cycle.
func ValidQuotaPeriod(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case QuotaPeriodNone, QuotaPeriodDaily, QuotaPeriodWeekly, QuotaPeriodMonthly:
		return true
	default:
		return false
	}
}

// DefaultQuotaTimezone is where a period boundary falls when a token names none.
//
// UTC rather than the host's local zone: a period boundary that moves when the
// service is redeployed to a machine in another region would silently reset a
// quota early or late, and the operator would have no way to see why.
const DefaultQuotaTimezone = "UTC"

// LoadQuotaLocation resolves a stored timezone name.
//
// An unknown or blank name falls back to UTC rather than failing. This runs on the
// admission path, and refusing traffic because a tzdata name stopped resolving —
// after a Go upgrade, or on a system without tzdata — would take a working
// deployment down over a display detail. The console validates the name at write
// time, so this only fires on a row edited out of band.
func LoadQuotaLocation(name string) *time.Location {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return time.UTC
	}
	location, err := time.LoadLocation(trimmed)
	if err != nil {
		return time.UTC
	}
	return location
}

// ValidateQuotaTimezone judges a console-supplied timezone.
func ValidateQuotaTimezone(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) > 64 {
		return ErrString("quota timezone must be at most 64 characters")
	}
	if _, err := time.LoadLocation(trimmed); err != nil {
		return ErrString("quota timezone must be an IANA name such as UTC or Asia/Shanghai")
	}
	return nil
}

// QuotaPeriodStamp is the value stored on the token row and bound to every
// reservation and usage row. It is what makes late-arriving usage safe.
//
// It is the period type and the calendar key together — "daily:2026-08-19" — and
// the type is part of it because two keys are only comparable within one type.
// Key shapes differ ("2026-08-19" against "2026-08"), so after an operator
// switches a token from monthly to daily the bare keys compare in an order that
// means nothing: the daily key sorts greater and would look like a new period,
// handing back budget already spent, while the reverse switch would look like a
// straggler and silently drop real usage. Carrying the type lets the applying
// statement recognise "these are not comparable" and accumulate instead.
//
// It is derived rather than incremented, which is why rollover needs no scheduled
// job and no recovery after a restart: any process, at any time, computes the same
// stamp for the same instant without agreeing on stored state. A generation counter
// would have to be advanced by exactly one party exactly once.
//
// Empty for QuotaPeriodNone, which is one endless period.
func QuotaPeriodStamp(period string, at time.Time, location *time.Location) string {
	key := QuotaPeriodKey(period, at, location)
	if key == "" {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(period)) + ":" + key
}

// QuotaPeriodKey is the calendar key an instant falls in, without the period type.
//
// This is the human-readable half, for the console. The value that is stored and
// compared is QuotaPeriodStamp.
//
// Shapes, all in the token's own timezone:
//
//	none     ""            the limit never resets, so there is one endless period
//	daily    "2026-08-19"
//	weekly   "2026-W34"    ISO week, so the last days of December belong to the
//	                       week that owns them rather than to a stray 53rd
//	monthly  "2026-08"
func QuotaPeriodKey(period string, at time.Time, location *time.Location) string {
	if location == nil {
		location = time.UTC
	}
	local := at.In(location)

	switch strings.ToLower(strings.TrimSpace(period)) {
	case QuotaPeriodDaily:
		return local.Format("2006-01-02")
	case QuotaPeriodWeekly:
		// ISOWeek rather than a day-of-year division: the latter disagrees with
		// every calendar an operator would check the boundary against, and puts a
		// two-day 53rd week at the end of some years.
		year, week := local.ISOWeek()
		return isoWeekKey(year, week)
	case QuotaPeriodMonthly:
		return local.Format("2006-01")
	default:
		// QuotaPeriodNone and anything unrecognised. One endless period, so a row
		// edited out of band accumulates rather than resetting unpredictably.
		return ""
	}
}

func isoWeekKey(year, week int) string {
	weekPart := "W"
	if week < 10 {
		weekPart += "0"
	}
	return formatQuotaInt(year) + "-" + weekPart + formatQuotaInt(week)
}

func formatQuotaInt(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := make([]byte, 0, 12)
	for value > 0 {
		digits = append(digits, byte('0'+value%10))
		value /= 10
	}
	for left, right := 0, len(digits)-1; left < right; left, right = left+1, right-1 {
		digits[left], digits[right] = digits[right], digits[left]
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

// QuotaPeriodBounds reports the half-open interval [start, end) the given instant
// falls in, for display.
//
// Only the console reads these. Admission compares period keys instead, because a
// key comparison cannot disagree with itself the way two derived instants can when
// one is computed slightly later than the other.
//
// Both are zero for QuotaPeriodNone: there is no next reset to show.
func QuotaPeriodBounds(period string, at time.Time, location *time.Location) (time.Time, time.Time) {
	if location == nil {
		location = time.UTC
	}
	local := at.In(location)

	switch strings.ToLower(strings.TrimSpace(period)) {
	case QuotaPeriodDaily:
		// Constructed from calendar fields rather than by truncating: Truncate works
		// on absolute time, so it lands on the wrong instant in any zone whose
		// offset is not a whole number of hours from UTC, and it ignores DST
		// entirely.
		start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
		return start, start.AddDate(0, 0, 1)
	case QuotaPeriodWeekly:
		// Monday, to agree with the ISO week the key is built from.
		offset := (int(local.Weekday()) + 6) % 7
		start := time.Date(local.Year(), local.Month(), local.Day()-offset, 0, 0, 0, 0, location)
		return start, start.AddDate(0, 0, 7)
	case QuotaPeriodMonthly:
		start := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, location)
		// AddDate normalises, so January + 1 month is February whatever the day
		// count, and a period starting on the 1st never lands on the 31st of a
		// month that has 30 days.
		return start, start.AddDate(0, 1, 0)
	default:
		return time.Time{}, time.Time{}
	}
}

// QuotaPeriodState is what the console shows about a token's cycle.
type QuotaPeriodState struct {
	// Period is none, daily, weekly or monthly.
	Period string `json:"period"`
	// Timezone is the IANA name the boundary is computed in.
	Timezone string `json:"timezone"`
	// PeriodKey identifies the current cycle; empty for QuotaPeriodNone.
	PeriodKey string `json:"period_key"`
	// PeriodStart and PeriodEnd bound the current cycle as RFC3339, or are nil for
	// QuotaPeriodNone. The interval is half-open: [start, end).
	PeriodStart *string `json:"period_start"`
	PeriodEnd   *string `json:"period_end"`
	// NextResetAt equals PeriodEnd, named for what an operator wants to know.
	NextResetAt *string `json:"next_reset_at"`
}

// NewQuotaPeriodState derives the reported cycle at a given instant.
func NewQuotaPeriodState(period, timezone string, at time.Time) QuotaPeriodState {
	resolved := period
	if !ValidQuotaPeriod(resolved) {
		resolved = DefaultQuotaPeriod
	}
	resolved = strings.ToLower(strings.TrimSpace(resolved))

	zoneName := strings.TrimSpace(timezone)
	if zoneName == "" {
		zoneName = DefaultQuotaTimezone
	}
	location := LoadQuotaLocation(zoneName)

	state := QuotaPeriodState{
		Period:    resolved,
		Timezone:  zoneName,
		PeriodKey: QuotaPeriodKey(resolved, at, location),
	}
	start, end := QuotaPeriodBounds(resolved, at, location)
	if !start.IsZero() {
		startText := start.Format(time.RFC3339)
		endText := end.Format(time.RFC3339)
		state.PeriodStart = &startText
		state.PeriodEnd = &endText
		state.NextResetAt = &endText
	}
	return state
}
