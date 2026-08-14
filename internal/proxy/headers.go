package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// HopByHopHeaders must not be forwarded to the upstream.
var HopByHopHeaders = []string{
	"connection",
	"keep-alive",
	"transfer-encoding",
	"host",
	"content-length",
	"te",
	"trailer",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"x-wildtoken-upstream",
}

// DownstreamCredentialHeaders are accepted from downstream clients but never
// forwarded as-is.
//
// These are kept separate from HopByHopHeaders: the selected channel may
// legitimately inject or override x-api-key for an Anthropic upstream.
var DownstreamCredentialHeaders = []string{"authorization", "x-api-key"}

// NonOverridableHeaders carry transport semantics that a channel override must
// not control. x-wildtoken-upstream is internal routing metadata.
var NonOverridableHeaders = []string{
	"connection",
	"keep-alive",
	"transfer-encoding",
	"host",
	"content-length",
	"te",
	"trailer",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"x-wildtoken-upstream",
}

// ClientHeaderPlaceholderPrefix introduces a channel header value that copies a
// downstream request header.
const ClientHeaderPlaceholderPrefix = "{client_header:"

// LogRedactedHeaders always have their values redacted in logging context.
var LogRedactedHeaders = []string{
	"authorization",
	"api-key",
	"x-api-key",
	"cookie",
	"set-cookie",
	"proxy-authorization",
	"proxy-authenticate",
	"x-admin-token",
	"x-auth-token",
	"x-access-token",
	"x-goog-api-key",
	"x-amz-security-token",
}

// sensitiveHeaderParts are the name segments that mark a header as carrying a
// credential, so a custom header nobody listed is still redacted.
var sensitiveHeaderParts = map[string]bool{
	"auth":          true,
	"authorization": true,
	"apikey":        true,
	"credential":    true,
	"credentials":   true,
	"key":           true,
	"secret":        true,
	"signature":     true,
	"token":         true,
	"cookie":        true,
}

// IsSensitiveHeaderName reports whether a header's value must be redacted.
func IsSensitiveHeaderName(name string) bool {
	for _, header := range LogRedactedHeaders {
		if strings.EqualFold(name, header) {
			return true
		}
	}

	lowered := strings.ToLower(name)
	for _, part := range strings.FieldsFunc(lowered, func(r rune) bool {
		return r == '-' || r == '_'
	}) {
		if sensitiveHeaderParts[part] {
			return true
		}
	}
	return false
}

func containsFold(list []string, name string) bool {
	for _, entry := range list {
		if strings.EqualFold(entry, name) {
			return true
		}
	}
	return false
}

// parseClientHeaderPlaceholder reads a `{client_header:name}` override value.
// A placeholder must occupy the whole value, so a partial one is an error
// rather than a literal.
func parseClientHeaderPlaceholder(value string) (source string, isPlaceholder bool, err error) {
	if rest, found := strings.CutPrefix(value, ClientHeaderPlaceholderPrefix); found {
		inner, closed := strings.CutSuffix(rest, "}")
		if !closed || inner == "" {
			return "", false, fmt.Errorf("placeholder must name a header")
		}
		return inner, true, nil
	}
	if strings.Contains(value, ClientHeaderPlaceholderPrefix) {
		return "", false, fmt.Errorf("placeholder must occupy the whole value")
	}
	return "", false, nil
}

// connectionNominatedHeaders lists the fields the downstream Connection header
// declared hop-by-hop for this request.
func connectionNominatedHeaders(headers http.Header) map[string]bool {
	nominated := map[string]bool{}
	for _, value := range headers.Values("connection") {
		for _, name := range strings.Split(value, ",") {
			name = strings.ToLower(strings.TrimSpace(name))
			if name != "" {
				nominated[name] = true
			}
		}
	}
	return nominated
}

// validHeaderName reports whether a name is a valid HTTP field name.
//
// Every character is checked against the token set RFC 9110 defines. The check
// used to be CanonicalMIMEHeaderKey(name) != "", which is true of any non-empty
// string, so names carrying characters like "(" or "," were accepted and stored
// — and then rejected wholesale by the transport when the request was written,
// leaving a channel that fails every request with an error naming none of this.
func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for index := range len(name) {
		if !isHeaderNameByte(name[index]) {
			return false
		}
	}
	return true
}

// isHeaderNameByte reports whether c may appear in a field name, per the tchar
// production of RFC 9110.
func isHeaderNameByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0
}

// validHeaderValue rejects values that would let a caller inject a new field.
func validHeaderValue(value string) bool {
	return !strings.ContainsAny(value, "\r\n\x00")
}

// ValidateHeaderOverrides checks a channel's header override map before it is
// persisted or used by an admin preview request.
func ValidateHeaderOverrides(overrides map[string]string) error {
	normalizedNames := map[string]bool{}

	for name, value := range overrides {
		normalized := strings.ToLower(name)
		if !validHeaderName(name) {
			return fmt.Errorf("invalid Header name: %s", name)
		}

		source, isPlaceholder, err := parseClientHeaderPlaceholder(value)
		switch {
		case err != nil:
			return fmt.Errorf(
				"invalid client Header placeholder for %s; it must occupy the whole value", name)
		case isPlaceholder:
			if !validHeaderName(source) {
				return fmt.Errorf("invalid client Header placeholder for %s: %s", name, source)
			}
			// A placeholder must not be able to copy the caller's credentials
			// onto the upstream request, nor rewrite transport semantics.
			if containsFold(DownstreamCredentialHeaders, source) {
				return fmt.Errorf(
					"client credential Header %s cannot be used in an override", source)
			}
			if containsFold(NonOverridableHeaders, source) {
				return fmt.Errorf("client Header %s cannot be used in an override", source)
			}
		default:
			if !validHeaderValue(value) {
				return fmt.Errorf("invalid value for Header %s", name)
			}
		}

		if containsFold(NonOverridableHeaders, normalized) {
			return fmt.Errorf("Header %s cannot be overridden", name)
		}
		if normalizedNames[normalized] {
			return fmt.Errorf("duplicate Header name with different casing: %s", name)
		}
		normalizedNames[normalized] = true
	}

	return nil
}

// ApplyHeaderOverrides applies configured overrides last, using HTTP's
// case-insensitive name semantics. Callers must validate user input before
// persisting it.
func ApplyHeaderOverrides(headers map[string]string, overrides map[string]string,
	downstreamHeaders http.Header) {
	var nominated map[string]bool
	if downstreamHeaders != nil {
		nominated = connectionNominatedHeaders(downstreamHeaders)
	}

	for name, value := range overrides {
		source, isPlaceholder, err := parseClientHeaderPlaceholder(value)
		if err != nil {
			continue
		}

		resolved := value
		if isPlaceholder {
			// A field the downstream Connection header nominated is hop-by-hop
			// for this request, so it is not available to copy.
			if nominated[strings.ToLower(source)] || downstreamHeaders == nil {
				continue
			}
			resolved = downstreamHeaders.Get(source)
			if strings.TrimSpace(resolved) == "" {
				continue
			}
		}
		headers[strings.ToLower(name)] = resolved
	}
}

// BuildForwardHeaders filters hop-by-hop fields, injects the channel's API key,
// and merges its extra headers.
//
// Header names are normalized to lowercase so the gateway never emits
// case-duplicate keys (for example both Authorization and authorization), which
// many reverse proxies reject with a raw HTTP 400 HTML page.
//
// The downstream client's Authorization is intentionally dropped; the upstream
// key is injected under a single lowercase authorization name.
func BuildForwardHeaders(downstreamHeaders http.Header, upstream *models.UpstreamRow,
	path string) (map[string]string, error) {
	forwarded := map[string]string{}
	nominated := connectionNominatedHeaders(downstreamHeaders)

	for name, values := range downstreamHeaders {
		lowered := strings.ToLower(name)
		if containsFold(HopByHopHeaders, lowered) || nominated[lowered] {
			continue
		}
		// The client's credentials are never forwarded; they are replaced below
		// from the selected channel configuration.
		if containsFold(DownstreamCredentialHeaders, lowered) {
			continue
		}
		if len(values) > 0 {
			forwarded[lowered] = values[0]
		}
	}

	// Uncompressed responses are preferred, so usage can be read from body text.
	forwarded["accept-encoding"] = "identity"

	isAnthropicMessages := strings.Trim(path, "/") == "messages"

	if upstream.APIKey != nil && *upstream.APIKey != "" {
		key := *upstream.APIKey
		if isAnthropicMessages {
			forwarded["x-api-key"] = key
			// All supported Anthropic Messages API versions use this value. A
			// configured extra header below can explicitly override it.
			if _, exists := forwarded["anthropic-version"]; !exists {
				forwarded["anthropic-version"] = "2023-06-01"
			}
		} else {
			forwarded["authorization"] = "Bearer " + key
		}
	}

	// Extra headers merge last so they can override, with normalized keys.
	extra := map[string]string{}
	if err := json.Unmarshal([]byte(upstream.ExtraHeaders), &extra); err != nil {
		return nil, apperr.Upstream(fmt.Sprintf(
			"channel %s has invalid Header override JSON: %v", upstream.Name, err))
	}
	if err := ValidateHeaderOverrides(extra); err != nil {
		return nil, apperr.Upstream(fmt.Sprintf(
			"channel %s has an invalid Header override: %v", upstream.Name, err))
	}
	ApplyHeaderOverrides(forwarded, extra, downstreamHeaders)

	// A channel override must not reintroduce a field the downstream Connection
	// header explicitly nominated as hop-by-hop.
	for name := range nominated {
		delete(forwarded, name)
	}

	return forwarded, nil
}
