package models

import (
	"encoding/json"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	// AllowedModelsMaxEntries bounds one token's whitelist. The list is parsed on
	// every proxied request, so it is kept to a size an operator would plausibly
	// curate by hand rather than one that turns admission into a scan.
	AllowedModelsMaxEntries = 200
	// AllowedModelsPatternMaxChars bounds one entry. Model ids are short; a value
	// past this is a paste accident, not a model name.
	AllowedModelsPatternMaxChars = 200
)

// UnrestrictedAllowedModels is what an empty whitelist is stored as.
//
// NULL and '[]' both mean "no restriction", which is one meaning with two
// spellings — exactly the ambiguity the checklist requires be resolved. Writes
// normalize to this value, so every row written from here on spells it one way,
// and reads fold NULL into it, so rows predating the column agree.
const UnrestrictedAllowedModels = "[]"

// AllowedModelsPolicy is one token's model whitelist, parsed once for a request.
//
// The zero value is unrestricted, which is what an absent policy must mean: a
// token whose row predates the column, or whose group was resolved without one,
// has to keep working exactly as it did.
type AllowedModelsPolicy struct {
	// exact holds normalized literal ids. Lookup is by map because a token with
	// a long list is checked on every request.
	exact map[string]struct{}
	// prefixes holds the normalized text before a trailing '*', already lowered.
	prefixes []string
	// patterns is the operator's own list, in the order stored, for echoing back
	// to the console and for reporting in a refusal.
	patterns []string
}

// Unrestricted reports whether this policy permits every model.
//
// Callers must branch on this rather than on len(patterns): an empty list means
// unrestricted, and reading it as "nothing is allowed" would lock every caller
// out of a token nobody meant to restrict.
func (p AllowedModelsPolicy) Unrestricted() bool {
	return len(p.exact) == 0 && len(p.prefixes) == 0
}

// Patterns returns the stored list, for the console and for error text.
func (p AllowedModelsPolicy) Patterns() []string {
	if len(p.patterns) == 0 {
		return nil
	}
	out := make([]string, len(p.patterns))
	copy(out, p.patterns)
	return out
}

// Fingerprint identifies this policy's effect, for use in a cache key.
//
// Two tokens with the same whitelist share it, and any edit produces a different
// one — which is what lets the models-list cache carry the policy version in its
// key instead of needing an invalidation step when a token is edited. It is built
// from the normalized matching sets rather than the raw patterns, so reordering a
// list or changing its case does not split the cache into equivalent halves.
func (p AllowedModelsPolicy) Fingerprint() string {
	if p.Unrestricted() {
		return ""
	}
	parts := make([]string, 0, len(p.exact)+len(p.prefixes))
	for value := range p.exact {
		parts = append(parts, "="+value)
	}
	for _, prefix := range p.prefixes {
		parts = append(parts, "^"+prefix)
	}
	sort.Strings(parts)
	return strings.Join(parts, "\x00")
}

// normalizeModelPattern folds a model id or pattern to its comparison form.
//
// Case and surrounding space only: no trimming of vendor prefixes, no separator
// folding. The upstream matcher is deliberately fuzzier than this — see Permits.
func normalizeModelPattern(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// Permits reports whether a token may call the model it asked for.
//
// The rules are exact case-insensitive equality, plus a trailing '*' as an
// explicit prefix wildcard. Nothing else matches, and that is a deliberate
// departure from how upstream selection matches models: modelMatchScore also
// accepts a request that is a prefix or a suffix of a channel's model name, which
// is a helpful convenience when choosing where to send a request and a hole when
// deciding whether a request is allowed at all. Under suffix matching a token
// restricted to "gpt-4o-mini" would admit a request for "mini"; under prefix
// matching one restricted to "gpt-4o" would admit "gpt-4o-with-anything". A
// whitelist that answers yes to a model the operator did not list is worse than
// no whitelist, because it reads as enforced.
//
// A '*' on its own is therefore an explicit "everything", which an operator can
// write but which nothing implies.
func (p AllowedModelsPolicy) Permits(model string) bool {
	if p.Unrestricted() {
		return true
	}
	candidate := normalizeModelPattern(model)
	if candidate == "" {
		// A restricted token cannot be admitted without knowing what it asked
		// for. See RequiresModel for why this is the caller's decision to make.
		return false
	}
	if _, ok := p.exact[candidate]; ok {
		return true
	}
	for _, prefix := range p.prefixes {
		if strings.HasPrefix(candidate, prefix) {
			return true
		}
	}
	return false
}

// ParseAllowedModels reads a stored whitelist.
//
// A NULL column, an empty string, '[]' and a list of only blanks all resolve to
// unrestricted. A value that does not parse resolves to unrestricted as well,
// with the error returned: the caller on the request path admits the request
// rather than refusing traffic over a row that was edited out of band, and the
// same function serves the console, which does want to hear about it.
func ParseAllowedModels(stored *string) (AllowedModelsPolicy, error) {
	if stored == nil {
		return AllowedModelsPolicy{}, nil
	}
	raw := strings.TrimSpace(*stored)
	if raw == "" || raw == UnrestrictedAllowedModels {
		return AllowedModelsPolicy{}, nil
	}

	var entries []string
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return AllowedModelsPolicy{}, ErrString("allowed_models must be a JSON array of model names")
	}
	return buildAllowedModelsPolicy(entries), nil
}

// buildAllowedModelsPolicy compiles a validated entry list into matching sets.
func buildAllowedModelsPolicy(entries []string) AllowedModelsPolicy {
	policy := AllowedModelsPolicy{}
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		normalized := normalizeModelPattern(trimmed)
		policy.patterns = append(policy.patterns, trimmed)

		if strings.HasSuffix(normalized, "*") {
			prefix := strings.TrimSuffix(normalized, "*")
			// A bare "*" leaves an empty prefix, which every candidate starts
			// with. That is the operator writing "everything", so it is dropped
			// rather than stored as a rule: keeping it would leave Unrestricted()
			// reporting false while Permits admitted everything, which labels the
			// token as restricted in the console and gives it its own cache
			// fingerprint for an effect identical to having no list at all.
			//
			// The pattern stays in patterns, so the console still echoes back what
			// the operator typed.
			if prefix == "" {
				continue
			}
			policy.prefixes = append(policy.prefixes, prefix)
			continue
		}
		if policy.exact == nil {
			policy.exact = map[string]struct{}{}
		}
		policy.exact[normalized] = struct{}{}
	}
	return policy
}

// NormalizeAllowedModels validates a console-supplied whitelist and renders the
// value to store.
//
// The stored shape is the operator's own list, trimmed and deduplicated but not
// lowercased: the console echoes it back, and rewriting "GPT-4o" as "gpt-4o"
// would look like the save had mangled it. Matching is case-insensitive
// regardless, so the stored case has no effect on admission.
func NormalizeAllowedModels(entries []string) (string, error) {
	if len(entries) > AllowedModelsMaxEntries {
		return "", ErrString("allowed_models must contain at most 200 entries")
	}

	seen := map[string]struct{}{}
	kept := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if utf8.RuneCountInString(trimmed) > AllowedModelsPatternMaxChars {
			return "", ErrString("each allowed model must be at most 200 characters")
		}
		if strings.ContainsFunc(trimmed, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			return "", ErrString("allowed models must not contain control characters")
		}
		// A '*' anywhere but the end is not a rule this matcher implements, and
		// accepting it silently would store a pattern that never matches while
		// looking like it restricts something.
		if inner := strings.TrimSuffix(trimmed, "*"); strings.Contains(inner, "*") {
			return "", ErrString(
				"a wildcard is only supported as a trailing * , for example claude-3-*")
		}

		normalized := normalizeModelPattern(trimmed)
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		kept = append(kept, trimmed)
	}

	if len(kept) == 0 {
		return UnrestrictedAllowedModels, nil
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		return "", ErrString("allowed_models could not be encoded")
	}
	return string(encoded), nil
}

// AllowedModelsFromStored parses a stored value for the console, reporting the
// operator's list. A malformed value yields an empty list rather than an error,
// so one bad row does not make the token list unreadable.
func AllowedModelsFromStored(stored *string) []string {
	policy, err := ParseAllowedModels(stored)
	if err != nil {
		return nil
	}
	return policy.Patterns()
}
