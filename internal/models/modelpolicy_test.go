package models

import (
	"strings"
	"testing"
)

// policyFor compiles a whitelist the way a stored row would arrive.
func policyFor(t *testing.T, entries ...string) AllowedModelsPolicy {
	t.Helper()
	stored, err := NormalizeAllowedModels(entries)
	if err != nil {
		t.Fatalf("normalize %v: %v", entries, err)
	}
	policy, err := ParseAllowedModels(&stored)
	if err != nil {
		t.Fatalf("parse %q: %v", stored, err)
	}
	return policy
}

// TestAnEmptyWhitelistMeansUnrestricted fixes the one semantic the checklist
// calls out: NULL and [] must mean the same thing, and that thing is "no
// restriction". Reading an empty list as "nothing allowed" would lock every
// caller out of every token that has never been restricted.
func TestAnEmptyWhitelistMeansUnrestricted(t *testing.T) {
	empty := ""
	bracket := UnrestrictedAllowedModels
	blanks := `["", "  "]`

	for name, stored := range map[string]*string{
		"null column":     nil,
		"empty string":    &empty,
		"empty array":     &bracket,
		"array of blanks": &blanks,
	} {
		t.Run(name, func(t *testing.T) {
			policy, err := ParseAllowedModels(stored)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if !policy.Unrestricted() {
				t.Fatal("policy is restricted, want unrestricted")
			}
			if !policy.Permits("anything-at-all") {
				t.Error("an unrestricted policy refused a model")
			}
		})
	}
}

// TestWhitelistMatchesExactlyAndCaseInsensitively is the core rule. Case folding
// is a convenience; anything beyond equality is not.
func TestWhitelistMatchesExactlyAndCaseInsensitively(t *testing.T) {
	policy := policyFor(t, "GPT-4o", "claude-sonnet-4")

	for _, permitted := range []string{"GPT-4o", "gpt-4o", "GPT-4O", "claude-sonnet-4"} {
		if !policy.Permits(permitted) {
			t.Errorf("Permits(%q) = false, want true", permitted)
		}
	}
	for _, refused := range []string{"gpt-4", "gpt-4o-mini", "o-4o", "claude-sonnet-4-5"} {
		if policy.Permits(refused) {
			t.Errorf("Permits(%q) = true, want false", refused)
		}
	}
}

// TestWhitelistDoesNotInheritTheChannelMatchersFuzziness is the security
// property that separates this matcher from modelMatchScore.
//
// Channel selection accepts a request that is a prefix or a suffix of a channel's
// model name, which is a helpful convenience for routing and a hole for
// authorization: under those rules a token restricted to gpt-4o-mini would admit
// "mini", and one restricted to gpt-4o would admit "gpt-4o-anything". A whitelist
// that answers yes to a model the operator did not list is worse than none,
// because the console reports it as enforced.
func TestWhitelistDoesNotInheritTheChannelMatchersFuzziness(t *testing.T) {
	policy := policyFor(t, "gpt-4o-mini")

	// The suffix direction: "mini" is a suffix of the listed model.
	if policy.Permits("mini") {
		t.Error("a suffix of the listed model was admitted; suffix matching is a whitelist hole")
	}
	// The prefix direction: the listed model starts with the request.
	if policy.Permits("gpt") {
		t.Error("a prefix of the listed model was admitted")
	}
	// The other prefix direction: the request starts with the listed model.
	if policy.Permits("gpt-4o-mini-2024-07-18") {
		t.Error("an extension of the listed model was admitted without an explicit wildcard")
	}
}

// TestTrailingWildcardIsTheOnlyPatternForm keeps the wildcard explicit, and
// keeps a form this matcher does not implement from being stored as though it did.
func TestTrailingWildcardIsTheOnlyPatternForm(t *testing.T) {
	policy := policyFor(t, "claude-3-*")

	for _, permitted := range []string{"claude-3-opus", "claude-3-", "CLAUDE-3-HAIKU"} {
		if !policy.Permits(permitted) {
			t.Errorf("Permits(%q) = false, want the prefix wildcard to admit it", permitted)
		}
	}
	for _, refused := range []string{"claude-3", "claude-4-opus", "anthropic/claude-3-opus"} {
		if policy.Permits(refused) {
			t.Errorf("Permits(%q) = true, want false", refused)
		}
	}

	// An inner wildcard is refused at write time rather than stored as a pattern
	// that silently never matches.
	if _, err := NormalizeAllowedModels([]string{"gpt-*-turbo"}); err == nil {
		t.Error("an inner wildcard was accepted; it would store a rule that never matches")
	}
}

// TestABareWildcardReadsAsUnrestricted collapses the two ways of writing
// "everything", so the console's label and the cache fingerprint agree.
func TestABareWildcardReadsAsUnrestricted(t *testing.T) {
	policy := policyFor(t, "*")
	if !policy.Permits("literally-anything") {
		t.Fatal("a bare * refused a model")
	}
	if policy.Fingerprint() != "" {
		t.Errorf("fingerprint = %q, want the unrestricted fingerprint", policy.Fingerprint())
	}
}

// TestARestrictedPolicyRefusesAnUnnamedModel fixes the fail-closed direction.
//
// The alternative admits any request whose model the gateway could not read,
// which turns an unparseable body into a way past the whitelist.
func TestARestrictedPolicyRefusesAnUnnamedModel(t *testing.T) {
	restricted := policyFor(t, "gpt-4o")
	if restricted.Permits("") {
		t.Error("a restricted policy admitted a request that named no model")
	}
	if restricted.Permits("   ") {
		t.Error("a restricted policy admitted a blank model name")
	}

	// An unrestricted token is unaffected, so this strictness only applies to a
	// credential someone narrowed on purpose.
	if !(AllowedModelsPolicy{}).Permits("") {
		t.Error("an unrestricted policy refused a request that named no model")
	}
}

// TestFingerprintIdentifiesThePolicysEffect is what lets the models-list cache
// carry the policy version in its key instead of being invalidated on token edits.
func TestFingerprintIdentifiesThePolicysEffect(t *testing.T) {
	base := policyFor(t, "gpt-4o", "claude-3-*")

	// Order and case do not change the effect, so they must not split the cache.
	reordered := policyFor(t, "CLAUDE-3-*", "GPT-4O")
	if base.Fingerprint() != reordered.Fingerprint() {
		t.Errorf("reordering changed the fingerprint: %q vs %q",
			base.Fingerprint(), reordered.Fingerprint())
	}

	// Any real edit must change it, or a restricted token would keep reading the
	// list computed under its previous policy.
	for name, edited := range map[string]AllowedModelsPolicy{
		"an entry added":          policyFor(t, "gpt-4o", "claude-3-*", "gpt-4o-mini"),
		"an entry removed":        policyFor(t, "gpt-4o"),
		"exact became a wildcard": policyFor(t, "gpt-4o*", "claude-3-*"),
		"restriction lifted":      {},
	} {
		if edited.Fingerprint() == base.Fingerprint() {
			t.Errorf("%s did not change the fingerprint", name)
		}
	}
}

// TestNormalizeKeepsTheOperatorsSpellingAndDropsDuplicates: the console echoes
// this value back, so rewriting the case would look like the save mangled it.
func TestNormalizeKeepsTheOperatorsSpellingAndDropsDuplicates(t *testing.T) {
	stored, err := NormalizeAllowedModels([]string{" GPT-4o ", "gpt-4O", "", "claude-3-*"})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if !strings.Contains(stored, `"GPT-4o"`) {
		t.Errorf("stored = %s, want the operator's own spelling preserved", stored)
	}
	if strings.Count(stored, "gpt-4") > 1 && strings.Contains(stored, `"gpt-4O"`) {
		t.Errorf("stored = %s, want the case-insensitive duplicate dropped", stored)
	}

	policy, err := ParseAllowedModels(&stored)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := policy.Patterns(); len(got) != 2 {
		t.Errorf("patterns = %v, want the two distinct entries", got)
	}
}

// TestAMalformedStoredValueReadsAsUnrestrictedWithAnError lets the request path
// and the console take different actions on the same row: the proxy admits the
// request rather than refusing live traffic over a row edited out of band, and the
// console can report it.
func TestAMalformedStoredValueReadsAsUnrestrictedWithAnError(t *testing.T) {
	broken := `{"not":"an array"}`

	policy, err := ParseAllowedModels(&broken)
	if err == nil {
		t.Error("a malformed value parsed without an error")
	}
	if !policy.Unrestricted() {
		t.Error("a malformed value produced a restricting policy")
	}
	if patterns := AllowedModelsFromStored(&broken); patterns != nil {
		t.Errorf("console view = %v, want an empty list", patterns)
	}
}

// TestNormalizeRefusesValuesItCannotStoreFaithfully covers the write-time bounds.
func TestNormalizeRefusesValuesItCannotStoreFaithfully(t *testing.T) {
	tooMany := make([]string, AllowedModelsMaxEntries+1)
	for i := range tooMany {
		tooMany[i] = "model-" + strings.Repeat("x", i%5+1)
	}
	if _, err := NormalizeAllowedModels(tooMany); err == nil {
		t.Error("an oversized list was accepted")
	}
	if _, err := NormalizeAllowedModels([]string{
		strings.Repeat("m", AllowedModelsPatternMaxChars+1)}); err == nil {
		t.Error("an overlong entry was accepted")
	}
	if _, err := NormalizeAllowedModels([]string{"gpt\x004o"}); err == nil {
		t.Error("a control character was accepted")
	}
}
