package models

import "strings"

// ProxyPath is the part of a downstream URL that names the endpoint, with the
// /v1 prefix and any surrounding slashes removed: "chat/completions".
//
// Every decision that depends on which endpoint was addressed derives it from
// here. Deriving it separately is what let /v1//messages be read two ways at
// once — chi does not normalise paths, so a caller can send one, and the
// authenticating middleware and the forwarding code then disagreed about
// whether it was the Anthropic route.
//
// The prefix is matched as a whole segment, so a path like /v1beta/... keeps
// its first segment rather than being left as "beta/...".
func ProxyPath(urlPath string) string {
	trimmed := strings.Trim(urlPath, "/")
	if trimmed == "v1" {
		return ""
	}
	if rest, found := strings.CutPrefix(trimmed, "v1/"); found {
		trimmed = rest
	}
	return strings.Trim(trimmed, "/")
}

// IsAnthropicMessages reports whether a proxy path addresses the Anthropic
// Messages endpoint, which authenticates with x-api-key and speaks its own
// error shape.
func IsAnthropicMessages(proxyPath string) bool {
	return proxyPath == "messages"
}
