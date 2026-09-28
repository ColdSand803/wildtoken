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
// Messages API, which authenticates with x-api-key and speaks its own error
// shape.
//
// Sub-resources such as messages/count_tokens belong to it too. Matching only
// the bare path refused Claude Code's x-api-key on count_tokens, and forwarded
// the channel key there as a Bearer token Anthropic does not accept.
func IsAnthropicMessages(proxyPath string) bool {
	return proxyPath == "messages" || strings.HasPrefix(proxyPath, "messages/")
}

// ProxyEndpointAllowed reports whether the gateway relays a request: the
// inference endpoints, and nothing that manages an upstream account's state.
//
// Every path under /v1 used to pass through. Files, batches, fine-tuning jobs
// and the like belong to the upstream account every token shares, and the
// gateway has no owner for them: any token could list, download and delete
// what another had stored. Speech reports no usage, so under a quota it was
// free. A stored response is still reachable by its id, which only the
// request that created it holds.
func ProxyEndpointAllowed(method, proxyPath string) bool {
	switch {
	case proxyPath == "responses" || strings.HasPrefix(proxyPath, "responses/"):
		return true
	case method == "GET" && strings.HasPrefix(proxyPath, "models/"):
		return true
	case method != "POST":
		return false
	}
	switch proxyPath {
	case "chat/completions", "completions", "embeddings", "moderations",
		"messages", "messages/count_tokens",
		"images/generations", "images/edits", "images/variations":
		return true
	}
	return false
}
