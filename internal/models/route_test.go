package models

import "testing"

func TestProxyPathIsDerivedOneWay(t *testing.T) {
	for input, want := range map[string]string{
		"/v1/messages":         "messages",
		"/v1/messages/":        "messages",
		"/v1/chat/completions": "chat/completions",
		"/v1/models":           "models",
		"/v1":                  "",
		"/v1/":                 "",
		// chi does not normalise paths, so a caller can send these. They used
		// to be read as Anthropic by the forwarding code and as OpenAI by the
		// middleware authenticating the same request.
		"/v1//messages":    "messages",
		"//v1//messages//": "messages",
		// The prefix is a whole segment, so a longer first segment survives.
		"/v1beta/messages": "v1beta/messages",
		"/v1/v1/messages":  "v1/messages",
	} {
		if got := ProxyPath(input); got != want {
			t.Errorf("ProxyPath(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestAnthropicMessagesIsRecognisedThroughTheSameDerivation(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1//messages", "/v1/messages/"} {
		if !IsAnthropicMessages(ProxyPath(path)) {
			t.Errorf("%q was not recognised as the Anthropic Messages route", path)
		}
	}
	for _, path := range []string{"/v1/chat/completions", "/v1/models", "/v1/messages/count"} {
		if IsAnthropicMessages(ProxyPath(path)) {
			t.Errorf("%q was wrongly recognised as the Anthropic Messages route", path)
		}
	}
}
