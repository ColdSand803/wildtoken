package proxy

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// maxSSEEventBytes bounds one buffered SSE line, so a malformed stream that
// never emits a newline cannot grow the observer without end.
const maxSSEEventBytes = 4 * 1024 * 1024

// TokenUsage is the accounting a response reported.
type TokenUsage struct {
	PromptTokens              *int32
	CompletionTokens          *int32
	TotalTokens               *int32
	PromptCachedTokens        *int32
	CacheCreationTokens       *int32
	CompletionReasoningTokens *int32
}

// jsonValue is a decoded JSON document the extractors walk by key.
type jsonValue = map[string]any

func objectAt(value any, keys ...string) jsonValue {
	for _, key := range keys {
		object, ok := value.(jsonValue)
		if !ok {
			return nil
		}
		value = object[key]
	}
	object, _ := value.(jsonValue)
	return object
}

func valueAt(value any, keys ...string) any {
	for _, key := range keys {
		object, ok := value.(jsonValue)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}

func nonEmptyString(value any) bool {
	text, ok := value.(string)
	return ok && text != ""
}

func nonEmptyArray(value any) bool {
	items, ok := value.([]any)
	return ok && len(items) > 0
}

// jsonHasVisibleToken reports whether a parsed SSE payload carries the first
// visible generation token.
//
// Text deltas count, and so does the first non-empty tool-call delta, which is
// common when a model streams only function calls without any content or
// reasoning text.
func jsonHasVisibleToken(payload jsonValue) bool {
	// Anthropic Messages API streaming events.
	if eventType, _ := payload["type"].(string); eventType == "content_block_delta" ||
		eventType == "content_block_start" {
		delta := payload["delta"]
		if delta == nil {
			delta = payload["content_block"]
		}
		if nonEmptyString(valueAt(delta, "text")) ||
			nonEmptyString(valueAt(delta, "thinking")) ||
			nonEmptyString(valueAt(delta, "partial_json")) {
			return true
		}
	}

	if choices, ok := payload["choices"].([]any); ok {
		for _, choice := range choices {
			delta := valueAt(choice, "delta")
			if nonEmptyString(valueAt(delta, "content")) ||
				nonEmptyString(valueAt(delta, "reasoning_content")) ||
				nonEmptyString(valueAt(delta, "reasoning")) ||
				nonEmptyString(valueAt(delta, "text")) {
				return true
			}
			// Pure tool-call streams have no text content, so the first
			// tool_calls chunk counts as the first token. Otherwise agent and
			// tool turns would be left blank in the console.
			if nonEmptyArray(valueAt(delta, "tool_calls")) {
				return true
			}
			if nonEmptyString(valueAt(choice, "text")) ||
				nonEmptyString(valueAt(choice, "message", "content")) {
				return true
			}
			if nonEmptyArray(valueAt(choice, "message", "tool_calls")) {
				return true
			}
		}
	}

	// OpenAI Responses API streaming events.
	switch eventType, _ := payload["type"].(string); eventType {
	case "response.output_text.delta", "response.reasoning_text.delta",
		"response.reasoning_summary_text.delta", "response.function_call_arguments.delta",
		"response.custom_tool_call_input.delta":
		delta := payload["delta"]
		if nonEmptyString(delta) {
			return true
		}
		if object, ok := delta.(jsonValue); ok && len(object) > 0 {
			return true
		}
	}

	return false
}

// forEachSSELine walks a buffered body one newline-delimited line at a time,
// stopping early when visit returns false.
//
// The lines are slices of the body rather than copies. Converting the body to a
// string and splitting it allocated a second copy of the whole thing plus a
// slice header for every line it contained — several times the body's own size
// before a single byte had been parsed, and three separate readers each paid it
// for the same body. A large response from a channel answering in bad faith
// turned its size into a multiple of itself in memory.
func forEachSSELine(body []byte, visit func(line []byte) bool) {
	for len(body) > 0 {
		line, rest, found := bytes.Cut(body, []byte("\n"))
		if !visit(line) {
			return
		}
		if !found {
			return
		}
		body = rest
	}
}

// sseDataBytes returns the payload of a `data:` line, as a slice of the line.
func sseDataBytes(line []byte) ([]byte, bool) {
	rest, found := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:"))
	if !found {
		return nil, false
	}
	return bytes.TrimLeft(rest, " \t"), true
}

// HasVisibleToken reports whether a buffered SSE chunk contains a content token.
func HasVisibleToken(chunk []byte) bool {
	visible := false
	forEachSSELine(chunk, func(line []byte) bool {
		if sseBytesLineHasVisibleToken(line) {
			visible = true
			return false
		}
		return true
	})
	return visible
}

func sseLineHasVisibleToken(line string) bool {
	data, ok := sseData(line)
	if !ok || data == "" || data == "[DONE]" {
		return false
	}
	var payload jsonValue
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return false
	}
	return jsonHasVisibleToken(payload)
}

// sseData returns the payload of a `data:` line.
func sseData(line string) (string, bool) {
	rest, found := strings.CutPrefix(strings.TrimSpace(line), "data:")
	if !found {
		return "", false
	}
	return strings.TrimLeft(rest, " \t"), true
}

// usageInt32 reads a numeric usage field, which JSON decoding gives as float64.
//
// A figure that will not fit is reported as absent rather than as a substitute.
// int32() of an out-of-range or NaN float is implementation-defined and in
// practice lands on a large negative number, which the quota counter reads as
// "no usage" and skips — that buys free tokens. Saturating to the maximum
// instead is worse: one malformed report would spend a token's entire budget
// and persist it, leaving the customer locked out until an operator resets it.
//
// No real request spends two billion tokens, so a value that large is not a
// count at all, and the honest record is that this request's usage is unknown.
func usageInt32(value any) *int32 {
	number, ok := value.(float64)
	if !ok {
		return nil
	}
	// NaN fails both comparisons and is reported absent.
	if !(number >= 0 && number <= float64(math.MaxInt32)) {
		return nil
	}
	converted := int32(number)
	return &converted
}

// firstUsageInt32 returns the first field that is present.
func firstUsageInt32(values ...any) *int32 {
	for _, value := range values {
		if converted := usageInt32(value); converted != nil {
			return converted
		}
	}
	return nil
}

// sumTokenParts adds the parts that are present, or returns nil when none are.
//
// The sum is taken in int64 because three upstream-supplied counts can each be
// in range and still overflow int32 together, and a total that wrapped negative
// reads as "no usage" to the quota counter. A total that does not fit is
// reported absent, for the same reason usageInt32 does.
func sumTokenParts(parts ...*int32) *int32 {
	var sum int64
	any := false
	for _, part := range parts {
		if part != nil {
			any = true
			sum += int64(*part)
		}
	}
	if !any || sum > math.MaxInt32 {
		return nil
	}
	total := int32(sum)
	return &total
}

// isAnthropicStyleUsage distinguishes Anthropic Messages usage from OpenAI
// Chat and Responses usage.
//
// Anthropic:
//   - input_tokens is residual (uncached only); top-level cache fields are additive
//   - output_tokens already includes thinking; details are a breakdown only
//
// OpenAI and Codex:
//   - prompt_tokens/input_tokens already include cached tokens
//   - completion_tokens/output_tokens already include reasoning
//   - nested *_details and total_tokens are authoritative; details are never re-added
func isAnthropicStyleUsage(usage jsonValue) bool {
	if _, ok := usage["cache_read_input_tokens"]; ok {
		return true
	}
	if _, ok := usage["cache_read_tokens"]; ok {
		return true
	}
	if valueAt(usage, "output_tokens_details", "thinking_tokens") != nil {
		return true
	}
	_, hasCacheCreation := usage["cache_creation_input_tokens"]
	_, hasTotal := usage["total_tokens"]
	return hasCacheCreation && !hasTotal
}

func extractUsageValues(usage jsonValue) TokenUsage {
	// OpenAI reports prompt_tokens/completion_tokens; Responses, Codex and
	// Anthropic report input_tokens/output_tokens.
	rawPrompt := firstUsageInt32(usage["prompt_tokens"], usage["input_tokens"])
	rawCompletion := firstUsageInt32(usage["completion_tokens"], usage["output_tokens"])
	upstreamTotal := usageInt32(usage["total_tokens"])

	// Anthropic's additive top-level cache fields. OpenAI's nested cached_tokens
	// are a subset of prompt/input and must not be used for re-aggregation.
	topLevelCacheRead := firstUsageInt32(
		usage["cache_read_input_tokens"], usage["cache_read_tokens"])
	topLevelCacheCreation := firstUsageInt32(
		usage["cache_creation_input_tokens"], usage["cache_creation_tokens"])

	// The cache-read detail is an OpenAI subset or an Anthropic top-level field.
	promptCached := firstUsageInt32(
		valueAt(usage, "prompt_tokens_details", "cached_tokens"),
		valueAt(usage, "input_tokens_details", "cached_tokens"),
		usage["cache_read_input_tokens"],
		usage["cache_read_tokens"],
		valueAt(usage, "input_token_details", "cache_read"),
	)
	// The cache-write detail is an Anthropic creation field or OpenAI's
	// cache_write_tokens.
	cacheCreation := firstUsageInt32(
		usage["cache_creation_input_tokens"],
		usage["cache_creation_tokens"],
		valueAt(usage, "prompt_tokens_details", "cache_write_tokens"),
		valueAt(usage, "input_tokens_details", "cache_write_tokens"),
		valueAt(usage, "input_tokens_details", "cache_creation_tokens"),
		valueAt(usage, "input_tokens_details", "cache_creation"),
		valueAt(usage, "input_token_details", "cache_creation"),
	)
	// The reasoning and thinking detail is reported alone; it is never added
	// into completion_tokens.
	completionReasoning := firstUsageInt32(
		valueAt(usage, "completion_tokens_details", "reasoning_tokens"),
		valueAt(usage, "output_tokens_details", "reasoning_tokens"),
		valueAt(usage, "output_tokens_details", "thinking_tokens"),
		usage["thinking_tokens"],
	)

	anthropicStyle := isAnthropicStyleUsage(usage)

	prompt := rawPrompt
	if anthropicStyle {
		// Anthropic's total input is residual input plus cache write plus cache read.
		if aggregated := sumTokenParts(rawPrompt, topLevelCacheCreation, topLevelCacheRead); aggregated != nil {
			prompt = aggregated
		}
	}
	// For both vendors, output/completion is the inclusive billed total.
	completion := rawCompletion

	var total *int32
	switch {
	case anthropicStyle:
		// Anthropic has no total_tokens, so it is recomputed from the
		// aggregated input plus output.
		if prompt != nil && completion != nil {
			total = sumTokenParts(prompt, completion)
		} else if upstreamTotal != nil {
			total = upstreamTotal
		} else {
			total = sumTokenParts(prompt, completion)
		}
	case upstreamTotal != nil:
		// OpenAI's total_tokens is authoritative when present.
		total = upstreamTotal
	default:
		total = sumTokenParts(prompt, completion)
	}

	return TokenUsage{
		PromptTokens:              prompt,
		CompletionTokens:          completion,
		TotalTokens:               total,
		PromptCachedTokens:        promptCached,
		CacheCreationTokens:       cacheCreation,
		CompletionReasoningTokens: completionReasoning,
	}
}

// usageFromValue reads the usage object of a payload, at the top level or
// nested under `response`.
func usageFromValue(payload jsonValue) (TokenUsage, bool) {
	usage := objectAt(payload, "usage")
	if usage == nil {
		usage = objectAt(payload, "response", "usage")
	}
	if usage == nil {
		return TokenUsage{}, false
	}
	return extractUsageValues(usage), true
}

func responseReasoningEffortFromValue(payload jsonValue) (string, bool) {
	scope := any(payload)
	if nested := objectAt(payload, "response"); nested != nil {
		scope = nested
	}
	effort, ok := valueAt(scope, "reasoning", "effort").(string)
	if !ok {
		return "", false
	}
	effort = strings.TrimSpace(effort)
	return effort, effort != ""
}

// ExtractUsage reads token usage from either an SSE stream body or a JSON body.
func ExtractUsage(rawBody []byte, contentType string) TokenUsage {
	if IsSSEContentType(contentType) || strings.Contains(strings.ToLower(contentType), "sse") {
		// A stream reports usage repeatedly; the last report wins.
		var usage TokenUsage
		forEachSSELine(rawBody, func(line []byte) bool {
			data, ok := sseDataBytes(line)
			if !ok || string(data) == "[DONE]" {
				return true
			}
			var payload jsonValue
			if err := json.Unmarshal(data, &payload); err != nil {
				return true
			}
			if found, ok := usageFromValue(payload); ok {
				usage = found
			}
			return true
		})
		return usage
	}

	var payload jsonValue
	if err := json.Unmarshal(rawBody, &payload); err == nil {
		if usage, ok := usageFromValue(payload); ok {
			return usage
		}
	}
	return TokenUsage{}
}

// IsSSEContentType reports whether a content type marks a server-sent stream.
func IsSSEContentType(contentType string) bool {
	return strings.Contains(strings.ToLower(contentType), "event-stream")
}

func sseBytesLineHasVisibleToken(line []byte) bool {
	return sseLineHasVisibleToken(string(bytes.TrimSuffix(line, []byte("\r"))))
}

func isTerminalSSEEventType(eventType string) bool {
	switch eventType {
	case "response.completed", "response.failed", "response.incomplete",
		"response.cancelled", "message_stop", "error":
		return true
	default:
		return false
	}
}

// sseBytesLineIsTerminal reports whether a line ends the stream, either as an
// `event:` name or as the `type` of a data payload.
func sseBytesLineIsTerminal(line []byte) bool {
	text := strings.TrimSpace(string(bytes.TrimSuffix(line, []byte("\r"))))

	if name, found := strings.CutPrefix(text, "event:"); found &&
		isTerminalSSEEventType(strings.TrimSpace(name)) {
		return true
	}

	data, ok := sseData(text)
	if !ok {
		return false
	}
	if data == "[DONE]" {
		return true
	}

	var payload jsonValue
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return false
	}
	eventType, _ := payload["type"].(string)
	return isTerminalSSEEventType(eventType)
}

// sseObservation accumulates what a stream reveals as its bytes pass through.
type sseObservation struct {
	lineBuf                 []byte
	lineOverflow            bool
	firstTokenMs            *int32
	terminalEventPending    bool
	terminalEventSeen       bool
	usage                   TokenUsage
	responseReasoningEffort *string
}

// observeLine folds one complete line into the observation. elapsedMs reports
// how long the request has been running, for time-to-first-token.
func (o *sseObservation) observeLine(line []byte, elapsedMs func() int32) {
	if o.firstTokenMs == nil && sseBytesLineHasVisibleToken(line) {
		measured := elapsedMs()
		o.firstTokenMs = &measured
	}

	lineWithoutCR := bytes.TrimSuffix(line, []byte("\r"))
	if len(lineWithoutCR) == 0 {
		// A blank line closes an event, which is what confirms a pending
		// terminal event actually arrived in full.
		if o.terminalEventPending {
			o.terminalEventSeen = true
		}
		o.terminalEventPending = false
		return
	}

	if !o.terminalEventSeen && sseBytesLineIsTerminal(line) {
		o.terminalEventPending = true
	}

	data, ok := sseData(string(lineWithoutCR))
	if !ok || data == "" || data == "[DONE]" {
		return
	}
	var payload jsonValue
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return
	}
	if usage, ok := usageFromValue(payload); ok {
		o.usage = usage
	}
	if o.responseReasoningEffort == nil {
		if effort, ok := responseReasoningEffortFromValue(payload); ok {
			o.responseReasoningEffort = &effort
		}
	}
}

// observeChunk splits a chunk into lines, buffering an incomplete tail.
func (o *sseObservation) observeChunk(chunk []byte, elapsedMs func() int32) {
	for len(chunk) > 0 {
		newlineIndex := bytes.IndexByte(chunk, '\n')
		var segment []byte
		completeLine := newlineIndex >= 0
		if completeLine {
			segment = chunk[:newlineIndex]
			chunk = chunk[newlineIndex+1:]
		} else {
			segment = chunk
			chunk = nil
		}

		// An oversized line is discarded rather than buffered, and the discard
		// continues until its terminating newline arrives.
		if !o.lineOverflow {
			if len(o.lineBuf)+len(segment) <= maxSSEEventBytes {
				o.lineBuf = append(o.lineBuf, segment...)
			} else {
				o.lineBuf = o.lineBuf[:0]
				o.lineOverflow = true
			}
		}

		if completeLine {
			if !o.lineOverflow {
				o.observeLine(o.lineBuf, elapsedMs)
			}
			o.lineBuf = o.lineBuf[:0]
			o.lineOverflow = false
		}
	}
}

// finish observes a trailing partial line and settles a pending terminal event.
func (o *sseObservation) finish(elapsedMs func() int32) {
	if !o.lineOverflow && len(o.lineBuf) > 0 {
		o.observeLine(o.lineBuf, elapsedMs)
	}
	o.lineBuf = o.lineBuf[:0]
	o.lineOverflow = false

	if o.terminalEventPending {
		o.terminalEventSeen = true
		o.terminalEventPending = false
	}
}

// ExtractResponseReasoningEffort reads the effort a response reported.
func ExtractResponseReasoningEffort(rawBody []byte, contentType string) *string {
	if strings.Contains(contentType, "event-stream") || bytes.HasPrefix(rawBody, []byte("data:")) {
		var reported *string
		forEachSSELine(rawBody, func(line []byte) bool {
			data, ok := sseDataBytes(line)
			if !ok {
				return true
			}
			var payload jsonValue
			if err := json.Unmarshal(bytes.TrimSpace(data), &payload); err != nil {
				return true
			}
			if effort, ok := responseReasoningEffortFromValue(payload); ok {
				reported = &effort
				return false
			}
			return true
		})
		return reported
	}

	var payload jsonValue
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil
	}
	if effort, ok := responseReasoningEffortFromValue(payload); ok {
		return &effort
	}
	return nil
}

// responseCapture keeps a bounded prefix of a body while counting its true length.
type responseCapture struct {
	bytes      []byte
	byteLength int
	limit      int
}

func newResponseCapture(limit int) *responseCapture {
	return &responseCapture{limit: limit}
}

func (c *responseCapture) push(chunk []byte) {
	c.byteLength += len(chunk)
	remaining := c.limit - len(c.bytes)
	if remaining <= 0 {
		return
	}
	c.bytes = append(c.bytes, chunk[:min(len(chunk), remaining)]...)
}

// formatEffort renders a reasoning effort value that may be a string or number.
func formatEffort(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		trimmed := strings.TrimSpace(typed)
		return trimmed, trimmed != ""
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10), true
		}
		return strconv.FormatFloat(typed, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(typed), true
	default:
		return "", false
	}
}
