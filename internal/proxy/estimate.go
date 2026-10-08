package proxy

import (
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"
)

// estimateTextTokens approximates a tokenizer: about four ASCII characters per
// token and one per other character. Close for English and CJK, high for
// accented Latin, which is the safer side for a quota.
func estimateTextTokens(text string) int64 {
	var ascii, other int64
	for _, r := range text {
		if r < utf8.RuneSelf {
			ascii++
		} else {
			other++
		}
	}
	return (ascii+3)/4 + other
}

// estimateDeltaTokens counts the text one streamed event added: content,
// reasoning and tool-call arguments, in each protocol's shape.
func estimateDeltaTokens(payload jsonValue) int64 {
	var tokens int64
	add := func(value any) {
		if text, ok := value.(string); ok {
			tokens += estimateTextTokens(text)
		}
	}

	switch eventType, _ := payload["type"].(string); eventType {
	case "content_block_delta":
		delta := payload["delta"]
		add(valueAt(delta, "text"))
		add(valueAt(delta, "thinking"))
		add(valueAt(delta, "partial_json"))
	case "response.output_text.delta", "response.reasoning_text.delta",
		"response.reasoning_summary_text.delta", "response.function_call_arguments.delta",
		"response.custom_tool_call_input.delta":
		add(payload["delta"])
	}

	choices, _ := payload["choices"].([]any)
	for _, choice := range choices {
		delta := valueAt(choice, "delta")
		add(valueAt(delta, "content"))
		add(valueAt(delta, "reasoning_content"))
		add(valueAt(delta, "reasoning"))
		calls, _ := valueAt(delta, "tool_calls").([]any)
		for _, call := range calls {
			add(valueAt(call, "function", "name"))
			add(valueAt(call, "function", "arguments"))
		}
	}
	return tokens
}

// estimateRequestTokens approximates a request's prompt from its text. Inline
// data — a data: URL, or a long run with no whitespace, as base64 is — is
// skipped: an image costs its provider's rate, not its encoding's length.
func estimateRequestTokens(body []byte) int64 {
	var request any
	if err := json.Unmarshal(body, &request); err != nil {
		return estimateTextTokens(string(body))
	}

	var tokens int64
	var walk func(value any)
	walk = func(value any) {
		switch typed := value.(type) {
		case string:
			if strings.HasPrefix(typed, "data:") ||
				(len(typed) > 1024 && !strings.ContainsAny(typed, " \n\t")) {
				return
			}
			tokens += estimateTextTokens(typed)
		case []any:
			for _, item := range typed {
				walk(item)
			}
		case map[string]any:
			for _, item := range typed {
				walk(item)
			}
		}
	}
	walk(request)
	return tokens
}

// clampTokens narrows an estimate to the log's column type.
func clampTokens(tokens int64) int32 {
	return int32(min(max(tokens, 0), math.MaxInt32))
}
