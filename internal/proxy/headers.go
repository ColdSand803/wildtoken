package proxy

import "strings"

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
