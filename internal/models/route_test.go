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
	// Sub-resources are the same API: Claude Code calls count_tokens with the
	// same x-api-key it sends to messages.
	for _, path := range []string{"/v1/messages", "/v1//messages", "/v1/messages/",
		"/v1/messages/count_tokens", "/v1/messages/batches"} {
		if !IsAnthropicMessages(ProxyPath(path)) {
			t.Errorf("%q was not recognised as the Anthropic Messages route", path)
		}
	}
	for _, path := range []string{"/v1/chat/completions", "/v1/models", "/v1/messagesx"} {
		if IsAnthropicMessages(ProxyPath(path)) {
			t.Errorf("%q was wrongly recognised as the Anthropic Messages route", path)
		}
	}
}

// Inference is relayed; an upstream account's stored state is not.
func TestOnlyInferenceEndpointsAreRelayed(t *testing.T) {
	for _, allowed := range [][2]string{
		{"POST", "chat/completions"}, {"POST", "messages"}, {"POST", "messages/count_tokens"},
		{"POST", "responses"}, {"GET", "responses/resp_1"}, {"POST", "responses/compact"},
		{"POST", "images/generations"}, {"POST", "images/edits"}, {"POST", "embeddings"},
		{"GET", "models/gpt-5"},
	} {
		if !ProxyEndpointAllowed(allowed[0], allowed[1]) {
			t.Errorf("%s %s was refused", allowed[0], allowed[1])
		}
	}
	for _, refused := range [][2]string{
		{"GET", "files"}, {"POST", "files"}, {"DELETE", "files/file-1"}, {"POST", "batches"},
		{"GET", "fine_tuning/jobs"}, {"POST", "messages/batches"}, {"GET", "chat/completions"},
		{"POST", "audio/speech"}, {"POST", "vector_stores"}, {"POST", "chat//completions"},
	} {
		if ProxyEndpointAllowed(refused[0], refused[1]) {
			t.Errorf("%s %s was relayed", refused[0], refused[1])
		}
	}
}
