package models

import (
	"testing"
	"time"
)

func mustLoad(t *testing.T, name string) *time.Location {
	t.Helper()
	location, err := time.LoadLocation(name)
	if err != nil {
		t.Skipf("timezone %s unavailable on this system: %v", name, err)
	}
	return location
}

func at(t *testing.T, value string, location *time.Location) time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation("2006-01-02 15:04:05", value, location)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return parsed
}

// TestNoPeriodMeansOneEndlessCycle keeps the legacy behaviour exactly as it was:
// a lifetime total, cleared only by an operator.
func TestNoPeriodMeansOneEndlessCycle(t *testing.T) {
	for _, instant := range []string{
		"2026-01-01 00:00:00", "2026-08-19 23:59:59", "2027-03-01 12:00:00",
	} {
		if key := QuotaPeriodKey(QuotaPeriodNone, at(t, instant, time.UTC), time.UTC); key != "" {
			t.Errorf("key at %s = %q, want empty for a token that never resets", instant, key)
		}
	}
	// And no bounds to report, because there is no next reset.
	start, end := QuotaPeriodBounds(QuotaPeriodNone, time.Now(), time.UTC)
	if !start.IsZero() || !end.IsZero() {
		t.Errorf("bounds = (%v, %v), want zero for no period", start, end)
	}

	// An unrecognised stored value behaves the same way rather than resetting on
	// some boundary nobody configured.
	if key := QuotaPeriodKey("fortnightly", time.Now(), time.UTC); key != "" {
		t.Errorf("key for an unknown period = %q, want empty", key)
	}
}

// TestTheBoundaryFallsInTheTokensTimezone is the requirement that a period is a
// local calendar concept, not a UTC one.
func TestTheBoundaryFallsInTheTokensTimezone(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai") // UTC+8, no DST

	// 2026-08-19 20:00 UTC is already 2026-08-20 04:00 in Shanghai, so the two
	// zones disagree about which day this is — which is the whole point.
	instant := at(t, "2026-08-19 20:00:00", time.UTC)

	if key := QuotaPeriodKey(QuotaPeriodDaily, instant, time.UTC); key != "2026-08-19" {
		t.Errorf("UTC key = %q, want 2026-08-19", key)
	}
	if key := QuotaPeriodKey(QuotaPeriodDaily, instant, shanghai); key != "2026-08-20" {
		t.Errorf("Shanghai key = %q, want 2026-08-20", key)
	}

	// The bounds agree with the key: midnight local, not midnight UTC shifted.
	start, end := QuotaPeriodBounds(QuotaPeriodDaily, instant, shanghai)
	if start.Hour() != 0 || start.Minute() != 0 {
		t.Errorf("start = %v, want local midnight", start)
	}
	if got := end.Sub(start); got != 24*time.Hour {
		t.Errorf("period length = %v, want 24h in a zone without DST", got)
	}
}

// TestMonthlyPeriodsHandleUnequalMonthLengths is the month-end case the checklist
// calls out. A period that starts on the 1st must never land on the 31st of a
// month that has 30 days.
func TestMonthlyPeriodsHandleUnequalMonthLengths(t *testing.T) {
	for name, testCase := range map[string]struct {
		instant  string
		wantKey  string
		wantDays int
	}{
		"31-day month":             {"2026-01-15 12:00:00", "2026-01", 31},
		"28-day February":          {"2026-02-15 12:00:00", "2026-02", 28},
		"29-day leap February":     {"2028-02-15 12:00:00", "2028-02", 29},
		"30-day month":             {"2026-04-15 12:00:00", "2026-04", 30},
		"last instant of a month":  {"2026-01-31 23:59:59", "2026-01", 31},
		"first instant of a month": {"2026-02-01 00:00:00", "2026-02", 28},
	} {
		t.Run(name, func(t *testing.T) {
			instant := at(t, testCase.instant, time.UTC)
			if key := QuotaPeriodKey(QuotaPeriodMonthly, instant, time.UTC); key != testCase.wantKey {
				t.Errorf("key = %q, want %q", key, testCase.wantKey)
			}
			start, end := QuotaPeriodBounds(QuotaPeriodMonthly, instant, time.UTC)
			if start.Day() != 1 {
				t.Errorf("start = %v, want the 1st", start)
			}
			if end.Day() != 1 {
				t.Errorf("end = %v, want the 1st of the next month", end)
			}
			if days := int(end.Sub(start).Hours() / 24); days != testCase.wantDays {
				t.Errorf("period spans %d days, want %d", days, testCase.wantDays)
			}
		})
	}

	// December rolls the year rather than producing month 13.
	december := at(t, "2026-12-15 12:00:00", time.UTC)
	_, end := QuotaPeriodBounds(QuotaPeriodMonthly, december, time.UTC)
	if end.Year() != 2027 || end.Month() != time.January {
		t.Errorf("December's period ends at %v, want 2027-01-01", end)
	}
}

// TestWeeklyPeriodsUseISOWeeks so the boundary agrees with a calendar and the
// year-end does not produce a stray two-day week.
func TestWeeklyPeriodsUseISOWeeks(t *testing.T) {
	// 2026-08-19 is a Wednesday in ISO week 34.
	wednesday := at(t, "2026-08-19 12:00:00", time.UTC)
	if key := QuotaPeriodKey(QuotaPeriodWeekly, wednesday, time.UTC); key != "2026-W34" {
		t.Errorf("key = %q, want 2026-W34", key)
	}

	// Every day of that week shares the key, and the period starts on Monday.
	start, end := QuotaPeriodBounds(QuotaPeriodWeekly, wednesday, time.UTC)
	if start.Weekday() != time.Monday {
		t.Errorf("start falls on %v, want Monday", start.Weekday())
	}
	if got := end.Sub(start); got != 7*24*time.Hour {
		t.Errorf("period length = %v, want 7 days", got)
	}
	for day := 0; day < 7; day++ {
		instant := start.AddDate(0, 0, day)
		if key := QuotaPeriodKey(QuotaPeriodWeekly, instant, time.UTC); key != "2026-W34" {
			t.Errorf("day %d of the week has key %q, want 2026-W34", day, key)
		}
	}

	// The week is zero padded, so keys sort chronologically as strings — which is
	// what the applying UPDATE relies on to tell an earlier period from a later one.
	early := QuotaPeriodKey(QuotaPeriodWeekly, at(t, "2026-01-07 12:00:00", time.UTC), time.UTC)
	if early != "2026-W02" {
		t.Errorf("early-January key = %q, want zero-padded 2026-W02", early)
	}
	if !(early < "2026-W34") {
		t.Errorf("%q does not sort before 2026-W34; the rollover comparison would break", early)
	}
}

// TestPeriodKeysSortChronologically is load-bearing: the applying UPDATE decides
// "same period", "a later period" and "an earlier period" by string comparison.
func TestPeriodKeysSortChronologically(t *testing.T) {
	for name, testCase := range map[string]struct {
		period  string
		earlier string
		later   string
	}{
		"daily across a month":  {QuotaPeriodDaily, "2026-01-31 12:00:00", "2026-02-01 12:00:00"},
		"daily across a year":   {QuotaPeriodDaily, "2026-12-31 12:00:00", "2027-01-01 12:00:00"},
		"monthly across a year": {QuotaPeriodMonthly, "2026-12-15 12:00:00", "2027-01-15 12:00:00"},
		"weekly within a year":  {QuotaPeriodWeekly, "2026-03-02 12:00:00", "2026-03-09 12:00:00"},
		"weekly across a year":  {QuotaPeriodWeekly, "2026-12-21 12:00:00", "2027-01-11 12:00:00"},
	} {
		t.Run(name, func(t *testing.T) {
			earlier := QuotaPeriodKey(testCase.period, at(t, testCase.earlier, time.UTC), time.UTC)
			later := QuotaPeriodKey(testCase.period, at(t, testCase.later, time.UTC), time.UTC)
			if !(earlier < later) {
				t.Errorf("keys %q and %q do not sort chronologically", earlier, later)
			}
		})
	}
}

// TestDaylightSavingDoesNotSkipOrRepeatAPeriod covers the DST case the checklist
// names. A day that is 23 or 25 hours long is still exactly one period.
func TestDaylightSavingDoesNotSkipOrRepeatAPeriod(t *testing.T) {
	newYork := mustLoad(t, "America/New_York")

	// US DST 2026: forward on March 8 (23-hour day), back on November 1 (25-hour).
	for name, testCase := range map[string]struct {
		date  string
		hours float64
	}{
		"spring forward": {"2026-03-08", 23},
		"fall back":      {"2026-11-01", 25},
	} {
		t.Run(name, func(t *testing.T) {
			noon := at(t, testCase.date+" 12:00:00", newYork)
			start, end := QuotaPeriodBounds(QuotaPeriodDaily, noon, newYork)

			// The key is the calendar date regardless of how long the day is.
			if key := QuotaPeriodKey(QuotaPeriodDaily, noon, newYork); key != testCase.date {
				t.Errorf("key = %q, want %s", key, testCase.date)
			}
			// The period covers the whole local day, which is not 24 hours.
			if hours := end.Sub(start).Hours(); hours != testCase.hours {
				t.Errorf("period spans %v hours, want %v", hours, testCase.hours)
			}
			// Every hour of that day belongs to it, so no request falls into a gap
			// or gets counted in two periods.
			for instant := start; instant.Before(end); instant = instant.Add(time.Hour) {
				if key := QuotaPeriodKey(QuotaPeriodDaily, instant, newYork); key != testCase.date {
					t.Errorf("%v has key %q, want %s", instant, key, testCase.date)
				}
			}
			// And the next period starts exactly where this one ends.
			nextStart, _ := QuotaPeriodBounds(QuotaPeriodDaily, end, newYork)
			if !nextStart.Equal(end) {
				t.Errorf("next period starts at %v, want %v — a gap or overlap", nextStart, end)
			}
		})
	}
}

// TestConsecutivePeriodsTileWithoutGapsOrOverlaps is the general form of the
// property the DST test checks at two specific dates.
func TestConsecutivePeriodsTileWithoutGapsOrOverlaps(t *testing.T) {
	newYork := mustLoad(t, "America/New_York")

	for _, period := range []string{QuotaPeriodDaily, QuotaPeriodWeekly, QuotaPeriodMonthly} {
		instant := at(t, "2026-01-15 12:00:00", newYork)
		// Walk a year of periods, checking each abuts the next.
		for range 60 {
			start, end := QuotaPeriodBounds(period, instant, newYork)
			if !start.Before(end) {
				t.Fatalf("%s: start %v is not before end %v", period, start, end)
			}
			nextStart, nextEnd := QuotaPeriodBounds(period, end, newYork)
			if !nextStart.Equal(end) {
				t.Errorf("%s: period ending %v is followed by one starting %v",
					period, end, nextStart)
			}
			// The boundary instant belongs to the next period, never to both:
			// the interval is half-open.
			if QuotaPeriodKey(period, end, newYork) == QuotaPeriodKey(period, start, newYork) {
				t.Errorf("%s: the end instant %v shares a key with the period it closes",
					period, end)
			}
			instant = nextEnd.Add(-time.Hour)
		}
	}
}

// TestAnUnknownTimezoneFallsBackToUTC keeps a row edited out of band from taking
// the admission path down.
func TestAnUnknownTimezoneFallsBackToUTC(t *testing.T) {
	for _, name := range []string{"", "   ", "Not/AZone", "Mars/Olympus_Mons"} {
		if location := LoadQuotaLocation(name); location != time.UTC {
			t.Errorf("LoadQuotaLocation(%q) = %v, want UTC", name, location)
		}
	}
	// But the console refuses it at write time, so the fallback is only ever a
	// backstop.
	if err := ValidateQuotaTimezone("Not/AZone"); err == nil {
		t.Error("an invalid timezone was accepted at write time")
	}
	if err := ValidateQuotaTimezone("Asia/Shanghai"); err != nil {
		t.Errorf("a valid timezone was refused: %v", err)
	}
	if err := ValidateQuotaTimezone(""); err != nil {
		t.Errorf("a blank timezone was refused; it should default: %v", err)
	}
}

// TestReportedStateNamesTheNextReset is what the console shows.
func TestReportedStateNamesTheNextReset(t *testing.T) {
	instant := at(t, "2026-08-19 12:00:00", time.UTC)

	state := NewQuotaPeriodState(QuotaPeriodDaily, "UTC", instant)
	if state.PeriodKey != "2026-08-19" {
		t.Errorf("period_key = %q, want 2026-08-19", state.PeriodKey)
	}
	if state.NextResetAt == nil {
		t.Fatal("next_reset_at is nil for a resetting token")
	}
	if *state.NextResetAt != "2026-08-20T00:00:00Z" {
		t.Errorf("next_reset_at = %q, want 2026-08-20T00:00:00Z", *state.NextResetAt)
	}
	if state.PeriodEnd == nil || *state.PeriodEnd != *state.NextResetAt {
		t.Error("period_end and next_reset_at disagree; they name the same instant")
	}

	// A token that never resets reports no next reset rather than a misleading one.
	none := NewQuotaPeriodState(QuotaPeriodNone, "UTC", instant)
	if none.NextResetAt != nil || none.PeriodStart != nil || none.PeriodEnd != nil {
		t.Errorf("a non-resetting token reported bounds: %+v", none)
	}
	if none.PeriodKey != "" {
		t.Errorf("period_key = %q, want empty", none.PeriodKey)
	}

	// An unrecognised stored period is reported as none, matching how admission
	// reads it — the console and the request path must not disagree.
	unknown := NewQuotaPeriodState("fortnightly", "UTC", instant)
	if unknown.Period != QuotaPeriodNone {
		t.Errorf("period = %q, want it reported as none", unknown.Period)
	}
	// A blank timezone is reported as the default rather than as empty.
	if blank := NewQuotaPeriodState(QuotaPeriodDaily, "", instant); blank.Timezone != DefaultQuotaTimezone {
		t.Errorf("timezone = %q, want %q", blank.Timezone, DefaultQuotaTimezone)
	}
}
