package models

import (
	"strings"
	"testing"
)

func TestParseQuotaExpressionAcceptsTheFormsOperatorsType(t *testing.T) {
	for _, testCase := range []struct {
		input string
		want  int64
	}{
		{"1000", 1000},
		{"1K", 1_000},
		{"1000K", 1_000_000},
		{"100M", 100_000_000},
		{"1B", 1_000_000_000},
		{"1T", 1_000_000_000_000},
		// Lower case and surrounding space are what a paste usually looks like.
		{"100m", 100_000_000},
		{"  50M  ", 50_000_000},
		// A limit is a rounded quantity, so a decimal is accepted.
		{"1.5M", 1_500_000},
		{"2.5K", 2_500},
	} {
		limit, err := ParseQuotaExpression(testCase.input)
		if err != nil {
			t.Errorf("ParseQuotaExpression(%q) failed: %v", testCase.input, err)
			continue
		}
		if limit == nil || *limit != testCase.want {
			t.Errorf("ParseQuotaExpression(%q) = %v, want %d", testCase.input, limit, testCase.want)
		}
	}
}

func TestAnEmptyQuotaMeansUnlimited(t *testing.T) {
	// Clearing the console field must remove the limit, not set it to zero.
	for _, input := range []string{"", "   "} {
		limit, err := ParseQuotaExpression(input)
		if err != nil {
			t.Errorf("ParseQuotaExpression(%q) failed: %v", input, err)
		}
		if limit != nil {
			t.Errorf("ParseQuotaExpression(%q) = %d, want unlimited", input, *limit)
		}
	}
}

func TestParseQuotaExpressionRejectsWhatCannotBeAQuota(t *testing.T) {
	for _, input := range []string{
		"abc",
		"M",        // a unit with no amount
		"100X",     // an unknown unit
		"-5M",      // negative
		"1e9",      // scientific notation is not an operator-facing form
		"100 M",    // an inner space would let a typo pass as two values
		"0",        // would block every request
		"0.0001K",  // rounds down to zero
		"9999999T", // beyond the storable range
	} {
		if limit, err := ParseQuotaExpression(input); err == nil {
			t.Errorf("ParseQuotaExpression(%q) = %v, want an error", input, limit)
		}
	}
}

func TestFormatQuotaRoundTripsTheShortestExactForm(t *testing.T) {
	for _, testCase := range []struct {
		limit int64
		want  string
	}{
		{1_000, "1K"},
		{1_000_000, "1M"},
		{100_000_000, "100M"},
		{1_000_000_000, "1B"},
		{1_000_000_000_000, "1T"},
		{1_500_000, "1.5M"},
		{2_500, "2.5K"},
		// Not a whole or single-decimal multiple, so the exact count is shown
		// rather than a rounded value that would not parse back.
		{1_234_567, "1234567"},
		{999, "999"},
	} {
		if got := FormatQuota(&testCase.limit); got != testCase.want {
			t.Errorf("FormatQuota(%d) = %q, want %q", testCase.limit, got, testCase.want)
		}
	}

	if got := FormatQuota(nil); got != "" {
		t.Errorf("FormatQuota(nil) = %q, want an empty string", got)
	}
}

func TestFormattedQuotaParsesBackToTheSameValue(t *testing.T) {
	// The console shows FormatQuota output in an editable field, so saving an
	// untouched form must not change the stored limit.
	for _, limit := range []int64{
		1, 999, 1_000, 2_500, 1_000_000, 1_500_000, 100_000_000,
		1_000_000_000, 1_234_567, 1_000_000_000_000,
	} {
		rendered := FormatQuota(&limit)
		parsed, err := ParseQuotaExpression(rendered)
		if err != nil {
			t.Errorf("FormatQuota(%d) = %q did not parse back: %v", limit, rendered, err)
			continue
		}
		if parsed == nil || *parsed != limit {
			t.Errorf("%d rendered as %q parsed back to %v", limit, rendered, parsed)
		}
	}
}

func TestQuotaStateReportsRemainingAndExhaustion(t *testing.T) {
	limit := int64(1_000_000)

	partial := NewQuotaState(400_000, &limit)
	if partial.RemainingTokens == nil || *partial.RemainingTokens != 600_000 {
		t.Errorf("remaining = %v, want 600000", partial.RemainingTokens)
	}
	if partial.Exhausted {
		t.Error("a token below its limit was reported as exhausted")
	}
	if partial.LimitExpression != "1M" {
		t.Errorf("limit expression = %q, want 1M", partial.LimitExpression)
	}

	// Reaching the limit exactly exhausts it; the next request is refused.
	exact := NewQuotaState(1_000_000, &limit)
	if !exact.Exhausted {
		t.Error("a token at its limit was not reported as exhausted")
	}
	if exact.RemainingTokens == nil || *exact.RemainingTokens != 0 {
		t.Errorf("remaining = %v, want 0", exact.RemainingTokens)
	}

	// The final request may overshoot, because its cost is only known after it
	// completes. Remaining is floored at zero rather than going negative.
	over := NewQuotaState(1_200_000, &limit)
	if over.RemainingTokens == nil || *over.RemainingTokens != 0 {
		t.Errorf("remaining = %v, want it floored at 0", over.RemainingTokens)
	}
	if !over.Exhausted {
		t.Error("an overshot token was not reported as exhausted")
	}
}

func TestAnUnlimitedTokenReportsNoRemainingOrExhaustion(t *testing.T) {
	state := NewQuotaState(999_999_999, nil)
	if state.LimitTokens != nil || state.RemainingTokens != nil {
		t.Errorf("unlimited state carried a limit: %+v", state)
	}
	if state.Exhausted {
		t.Error("an unlimited token was reported as exhausted")
	}
	if state.LimitExpression != "" {
		t.Errorf("limit expression = %q, want empty", state.LimitExpression)
	}
	if state.UsedTokens != 999_999_999 {
		t.Errorf("used = %d, want it still reported", state.UsedTokens)
	}
}

func TestValidateBaseURLRejectsWhatTheProxyCannotDial(t *testing.T) {
	for _, value := range []string{
		"https://api.example.com",
		"https://api.example.com/v1",
		"http://127.0.0.1:11434",
		"http://192.168.1.10:8080/v1",
		"  https://api.example.com  ",
	} {
		if _, err := ValidateBaseURL(value); err != nil {
			t.Errorf("ValidateBaseURL(%q) = %v, want it accepted", value, err)
		}
	}

	// A self-hosted model server is a first-class use of this gateway, so a
	// local or private address is deliberately not on this list.
	for _, value := range []string{
		"",
		"   ",
		"api.example.com",
		"file:///etc/passwd",
		"ftp://api.example.com",
		"https://",
		"https://api.example.com?key=secret",
		"https://api.example.com#fragment",
	} {
		if _, err := ValidateBaseURL(value); err == nil {
			t.Errorf("ValidateBaseURL(%q) was accepted", value)
		}
	}

	// The stored value is trimmed, so the console echoes back what it will dial.
	normalized, err := ValidateBaseURL("  https://api.example.com/v1  ")
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if normalized != "https://api.example.com/v1" {
		t.Errorf("normalized = %q, want the trimmed URL", normalized)
	}
}

func TestNameLengthIsMeasuredAfterTrimmingLikeStorageDoes(t *testing.T) {
	padding := strings.Repeat(" ", 40)

	// The stores trim before writing, so a name padded past the limit with
	// spaces was refused for a length it would never have had — the emptiness
	// check was already trimming while the length check beside it was not.
	token := APITokenIn{Name: padding + "caller" + padding, Enabled: true}
	if err := token.Validate(); err != nil {
		t.Errorf("a padded token name was refused: %v", err)
	}
	if token.Name != "caller" {
		t.Errorf("token name = %q, want it normalized to what gets stored", token.Name)
	}

	group := GroupIn{Name: padding + "team" + padding, Description: padding + "notes" + padding}
	if err := group.Validate(); err != nil {
		t.Errorf("a padded group name was refused: %v", err)
	}
	if group.Name != "team" || group.Description != "notes" {
		t.Errorf("group normalized to %q / %q", group.Name, group.Description)
	}

	// A name that is genuinely too long is still refused.
	long := APITokenIn{Name: strings.Repeat("x", APITokenNameMaxChars+1), Enabled: true}
	if err := long.Validate(); err == nil {
		t.Error("a name past the limit was accepted")
	}

	// And one that is only whitespace is still empty.
	blank := APITokenIn{Name: padding, Enabled: true}
	if err := blank.Validate(); err == nil {
		t.Error("a whitespace-only name was accepted")
	}
}
