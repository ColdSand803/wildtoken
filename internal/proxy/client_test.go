package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func int32Value(t *testing.T, value *int32) any {
	t.Helper()
	if value == nil {
		return nil
	}
	return *value
}

func TestStreamingChatRequestIncludesUsageAndPreservesOptions(t *testing.T) {
	body := []byte(`{"model":"requested-model","stream":true,"stream_options":{"include_obfuscation":true}}`)

	prepared := PrepareUpstreamBody(body, ptrTo("upstream-model"), "chat/completions")

	var decoded map[string]any
	if err := json.Unmarshal(prepared, &decoded); err != nil {
		t.Fatalf("decode prepared body: %v", err)
	}
	if decoded["model"] != "upstream-model" {
		t.Errorf("model = %v, want the forward model", decoded["model"])
	}
	options, ok := decoded["stream_options"].(map[string]any)
	if !ok {
		t.Fatalf("stream_options missing: %s", prepared)
	}
	if options["include_usage"] != true {
		t.Error("include_usage was not requested")
	}
	if options["include_obfuscation"] != true {
		t.Error("an existing stream option was dropped")
	}
}

func TestUsageOptionIsNotAddedToOtherOrNonStreamingRequests(t *testing.T) {
	for _, testCase := range []struct{ path, body string }{
		{"chat/completions", `{"model":"m","stream":false}`},
		{"responses", `{"model":"m","stream":true}`},
	} {
		prepared := PrepareUpstreamBody([]byte(testCase.body), nil, testCase.path)
		var decoded map[string]any
		if err := json.Unmarshal(prepared, &decoded); err != nil {
			t.Fatalf("decode %s: %v", testCase.path, err)
		}
		if _, present := decoded["stream_options"]; present {
			t.Errorf("%s gained stream_options: %s", testCase.path, prepared)
		}
	}
}

func TestExtractsReasoningEffortFromOpenAIAndAnthropicRequests(t *testing.T) {
	for _, testCase := range []struct {
		body string
		want any
	}{
		{`{"reasoning_effort":"high"}`, "high"},
		{`{"reasoning":{"effort":"medium"}}`, "medium"},
		{`{"thinking":{"type":"adaptive"},"output_config":{"effort":"xhigh"}}`, "xhigh"},
		{`{"thinking":{"type":"disabled"},"output_config":{"effort":"  high  "}}`, "high"},
		{`{"output_config":{"effort":"  "}}`, nil},
	} {
		effort := ExtractReasoningEffort([]byte(testCase.body))
		var got any
		if effort != nil {
			got = *effort
		}
		if got != testCase.want {
			t.Errorf("body %s gave %v, want %v", testCase.body, got, testCase.want)
		}
	}
}

func TestOpenAIReasoningEffortTakesPrecedenceOverAnthropicOutputConfig(t *testing.T) {
	body := []byte(`{"reasoning_effort":"low","reasoning":{"effort":"medium"},"output_config":{"effort":"high"}}`)
	effort := ExtractReasoningEffort(body)
	if effort == nil || *effort != "low" {
		t.Errorf("effort = %v, want low", effort)
	}
}

func assertUsage(t *testing.T, usage TokenUsage, want map[string]any) {
	t.Helper()
	got := map[string]any{
		"prompt":            int32Value(t, usage.PromptTokens),
		"completion":        int32Value(t, usage.CompletionTokens),
		"total":             int32Value(t, usage.TotalTokens),
		"prompt_cached":     int32Value(t, usage.PromptCachedTokens),
		"cache_creation":    int32Value(t, usage.CacheCreationTokens),
		"completion_reason": int32Value(t, usage.CompletionReasoningTokens),
	}
	for key, expected := range want {
		if got[key] != expected {
			t.Errorf("%s = %v, want %v", key, got[key], expected)
		}
	}
}

func TestExtractsUsageFromCodexResponsesCompletionEvent(t *testing.T) {
	response := []byte(`data: {"type":"response.completed","response":{"usage":{"input_tokens":99424,"output_tokens":440,"total_tokens":99864,"input_tokens_details":{"cached_tokens":12000},"output_tokens_details":{"reasoning_tokens":128}}}}

`)

	// OpenAI Responses and Codex report input/output as already complete, with
	// the cache and reasoning fields as subsets.
	assertUsage(t, ExtractUsage(response, "text/event-stream"), map[string]any{
		"prompt": int32(99424), "completion": int32(440), "total": int32(99864),
		"prompt_cached": int32(12000), "cache_creation": nil,
		"completion_reason": int32(128),
	})
}

func TestOpenAIChatCompletionsUsageKeepsDetailsAsSubsets(t *testing.T) {
	// Official OpenAI Chat Completions:
	//   prompt_tokens includes cached_tokens
	//   completion_tokens includes reasoning_tokens
	//   total_tokens = prompt + completion, authoritative when present
	// Details must never be added into the main columns.
	body := []byte(`{"usage":{"prompt_tokens":2006,"completion_tokens":300,"total_tokens":2306,
        "prompt_tokens_details":{"cached_tokens":1920,"cache_write_tokens":80},
        "completion_tokens_details":{"reasoning_tokens":128}}}`)

	assertUsage(t, ExtractUsage(body, "application/json"), map[string]any{
		"prompt": int32(2006), "completion": int32(300), "total": int32(2306),
		"prompt_cached": int32(1920), "cache_creation": int32(80),
		"completion_reason": int32(128),
	})
}

func TestOpenAIResponsesUsageDoesNotDoubleCountCachedOrReasoning(t *testing.T) {
	body := []byte(`{"usage":{"input_tokens":75,"input_tokens_details":{"cached_tokens":0},
        "output_tokens":1186,"output_tokens_details":{"reasoning_tokens":1024},"total_tokens":1261}}`)

	assertUsage(t, ExtractUsage(body, "application/json"), map[string]any{
		"prompt": int32(75), "completion": int32(1186), "total": int32(1261),
		"prompt_cached": int32(0), "completion_reason": int32(1024),
	})
}

func TestAggregatesAnthropicStyleInputWithoutAddingThinking(t *testing.T) {
	// Official Anthropic:
	//   input  = input_tokens + cache_creation + cache_read
	//   output = output_tokens, with thinking already included
	//   total  = input + output
	// A top-level thinking_tokens, if a proxy emits one, is detail only.
	body := []byte(`{"usage":{"input_tokens":100,"output_tokens":40,
        "cache_creation_input_tokens":20,"cache_read_input_tokens":30,"thinking_tokens":15}}`)

	assertUsage(t, ExtractUsage(body, "application/json"), map[string]any{
		"prompt": int32(150), "completion": int32(40), "total": int32(190),
		"prompt_cached": int32(30), "cache_creation": int32(20),
		"completion_reason": int32(15),
	})
}

func TestNestedThinkingTokensAreBreakdownNotAddedTwice(t *testing.T) {
	// output_tokens_details.thinking_tokens is a subset of output_tokens.
	body := []byte(`{"usage":{"input_tokens":100,"output_tokens":503,
        "cache_creation_input_tokens":50,"cache_read_input_tokens":25,
        "output_tokens_details":{"thinking_tokens":312}}}`)

	assertUsage(t, ExtractUsage(body, "application/json"), map[string]any{
		"prompt": int32(175), "completion": int32(503), "total": int32(678),
		"completion_reason": int32(312),
	})
}

func TestRecognizesSSEProtocolTerminalEvents(t *testing.T) {
	for _, line := range []string{
		"data: [DONE]",
		"event: response.completed",
		`data: {"type":"response.failed"}`,
		"event: message_stop",
		"event: error",
	} {
		if !sseBytesLineIsTerminal([]byte(line)) {
			t.Errorf("%q was not recognized as terminal", line)
		}
	}

	if sseBytesLineIsTerminal([]byte("event: response.output_item.done")) {
		t.Error("a non-terminal event was treated as terminal")
	}
}

func TestBuildUpstreamURLAvoidsDuplicatingTheVersionSegment(t *testing.T) {
	for _, testCase := range []struct{ base, path, query, want string }{
		{"https://api.example.com", "responses", "", "https://api.example.com/v1/responses"},
		{"https://api.example.com/", "/responses", "", "https://api.example.com/v1/responses"},
		{"https://api.example.com/v1", "responses", "", "https://api.example.com/v1/responses"},
		{"https://api.example.com/v1/", "responses", "", "https://api.example.com/v1/responses"},
		{"https://api.example.com", "models", "limit=5", "https://api.example.com/v1/models?limit=5"},
	} {
		upstream := models.UpstreamRow{BaseURL: testCase.base}
		if got := BuildUpstreamURL(&upstream, testCase.path, testCase.query); got != testCase.want {
			t.Errorf("base %q path %q gave %q, want %q",
				testCase.base, testCase.path, got, testCase.want)
		}
	}
}

func upstreamWithHeaders(t *testing.T, baseURL, extraHeaders string) models.UpstreamRow {
	t.Helper()
	key := "upstream-secret"
	return models.UpstreamRow{
		Name:         "channel",
		BaseURL:      baseURL,
		APIKey:       &key,
		ExtraHeaders: extraHeaders,
	}
}

func TestAnthropicMessagesUsesUpstreamAPIKeyAndHidesTheDownstreamKey(t *testing.T) {
	downstream := http.Header{}
	downstream.Set("x-api-key", "downstream-secret")
	upstream := upstreamWithHeaders(t, "https://api.anthropic.com", "{}")

	headers, err := BuildForwardHeaders(downstream, &upstream, "messages")
	if err != nil {
		t.Fatalf("build headers: %v", err)
	}
	if headers["x-api-key"] != "upstream-secret" {
		t.Errorf("x-api-key = %q, want the channel key", headers["x-api-key"])
	}
	if headers["anthropic-version"] != "2023-06-01" {
		t.Errorf("anthropic-version = %q, want the default", headers["anthropic-version"])
	}
	if _, present := headers["authorization"]; present {
		t.Error("an Anthropic request carried an authorization header")
	}
}

func TestChannelHeadersOverrideDownstreamAndGeneratedCredentialsCaseInsensitively(t *testing.T) {
	downstream := http.Header{}
	downstream.Set("user-agent", "downstream-agent")
	downstream.Set("x-request-id", "request-123")
	downstream.Set("authorization", "downstream-secret")

	upstream := upstreamWithHeaders(t, "https://example.test", `{
        "UsEr-AgEnT": "channel-agent",
        "AUTHORIZATION": "Token channel-credential",
        "X-Trace-Id": "channel-trace",
        "X-Upstream-Request": "{client_header:X-Request-Id}",
        "X-Missing": "{client_header:X-Not-Present}"
    }`)

	headers, err := BuildForwardHeaders(downstream, &upstream, "responses")
	if err != nil {
		t.Fatalf("build headers: %v", err)
	}

	for name, want := range map[string]string{
		"user-agent":         "channel-agent",
		"authorization":      "Token channel-credential",
		"x-trace-id":         "channel-trace",
		"x-upstream-request": "request-123",
	} {
		if headers[name] != want {
			t.Errorf("%s = %q, want %q", name, headers[name], want)
		}
	}
	// A placeholder naming an absent header contributes nothing.
	if _, present := headers["x-missing"]; present {
		t.Error("an unresolved placeholder produced a header")
	}

	// Names are normalized, so no case-duplicate key can reach the upstream.
	authorizationKeys := 0
	for name := range headers {
		if strings.EqualFold(name, "authorization") {
			authorizationKeys++
		}
	}
	if authorizationKeys != 1 {
		t.Errorf("found %d authorization keys, want exactly 1", authorizationKeys)
	}
}

func TestHeaderOverrideValidationRejectsAmbiguousOrTransportHeaders(t *testing.T) {
	duplicate := map[string]string{"Authorization": "one", "authorization": "two"}
	err := ValidateHeaderOverrides(duplicate)
	if err == nil || !strings.Contains(err.Error(), "duplicate Header") {
		t.Errorf("duplicate names gave %v, want a duplicate-header error", err)
	}

	for _, overrides := range []map[string]string{
		{"Host": "example.test"},
		{"Connection": "keep-alive"},
		{"X-Test": "one\r\ntwo"},
		{"X-Test": "prefix-{client_header:X-Request-Id}"},
		{"X-Test": "{client_header:Authorization}"},
	} {
		if err := ValidateHeaderOverrides(overrides); err == nil {
			t.Errorf("overrides %v were accepted", overrides)
		}
	}

	// A well-formed override is still accepted.
	if err := ValidateHeaderOverrides(map[string]string{
		"X-Trace": "value", "X-Copy": "{client_header:X-Request-Id}",
	}); err != nil {
		t.Errorf("a valid override was rejected: %v", err)
	}
}

func TestConnectionNominatedHeadersAreNotForwardedOrReintroduced(t *testing.T) {
	downstream := http.Header{}
	downstream.Set("connection", "x-hop, keep-alive")
	downstream.Set("x-hop", "downstream-value")

	upstream := upstreamWithHeaders(t, "https://example.test", `{
        "X-Hop": "channel-value",
        "X-Remapped-Hop": "{client_header:X-Hop}",
        "X-End-To-End": "kept"
    }`)

	headers, err := BuildForwardHeaders(downstream, &upstream, "responses")
	if err != nil {
		t.Fatalf("build headers: %v", err)
	}

	for _, name := range []string{"connection", "x-hop", "x-remapped-hop"} {
		if _, present := headers[name]; present {
			t.Errorf("a connection-nominated header survived: %s", name)
		}
	}
	if headers["x-end-to-end"] != "kept" {
		t.Errorf("an end-to-end header was dropped: %v", headers)
	}
}

func TestResponseCaptureRetainsOnlyTheConfiguredPrefix(t *testing.T) {
	capture := newResponseCapture(5)
	capture.push([]byte("abc"))
	capture.push([]byte("defgh"))

	if string(capture.bytes) != "abcde" {
		t.Errorf("captured %q, want the first 5 bytes", capture.bytes)
	}
	if capture.byteLength != 8 {
		t.Errorf("byte length = %d, want the full 8", capture.byteLength)
	}
}

func TestObservationExtractsTerminalMetadataAfterTheSnapshotLimit(t *testing.T) {
	capture := newResponseCapture(8)
	observation := &sseObservation{}
	measure := func() int32 { return 1 }

	first := []byte(`data: {"type":"response.output_text.delta","delta":"hello"}` + "\n\n")
	terminal := []byte(`data: {"type":"response.completed","response":{"reasoning":{"effort":"high"},` +
		`"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,` +
		`"input_tokens_details":{"cached_tokens":3},"cache_creation_input_tokens":5,` +
		`"output_tokens_details":{"reasoning_tokens":2}}}}` + "\n\n")

	response := append(append([]byte{}, first...), terminal...)
	for start := 0; start < len(response); start += 3 {
		chunk := response[start:min(start+3, len(response))]
		capture.push(chunk)
		observation.observeChunk(chunk, measure)
	}

	// Metadata is still read from events that fall past the snapshot limit.
	if len(capture.bytes) != 8 {
		t.Errorf("captured %d bytes, want the 8-byte limit", len(capture.bytes))
	}
	if capture.byteLength != len(first)+len(terminal) {
		t.Errorf("byte length = %d, want the full stream length", capture.byteLength)
	}
	assertUsage(t, observation.usage, map[string]any{
		"prompt": int32(11), "completion": int32(7), "total": int32(18),
		"prompt_cached": int32(3), "cache_creation": int32(5),
		"completion_reason": int32(2),
	})
	if observation.responseReasoningEffort == nil || *observation.responseReasoningEffort != "high" {
		t.Errorf("effort = %v, want high", observation.responseReasoningEffort)
	}
	if observation.firstTokenMs == nil {
		t.Error("no first token was observed")
	}
	if !observation.terminalEventSeen {
		t.Error("the terminal event was not observed")
	}
}

func TestObservationDiscardsAndRecoversFromAnOversizedEventLine(t *testing.T) {
	observation := &sseObservation{}
	measure := func() int32 { return 1 }

	oversized := make([]byte, maxSSEEventBytes+1)
	for i := range oversized {
		oversized[i] = 'x'
	}
	observation.observeChunk(oversized, measure)
	if !observation.lineOverflow {
		t.Error("an oversized line did not trip the overflow guard")
	}
	if len(observation.lineBuf) != 0 {
		t.Error("an oversized line was buffered")
	}

	// The next newline ends the discarded line, and observation resumes.
	observation.observeChunk([]byte("\ndata: [DONE]\n\n"), measure)
	if observation.lineOverflow {
		t.Error("the overflow guard did not reset")
	}
	if len(observation.lineBuf) != 0 {
		t.Error("the line buffer was not cleared")
	}
	if !observation.terminalEventSeen {
		t.Error("the stream did not recover to observe the terminal event")
	}
}
