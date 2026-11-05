package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

const (
	anthropicStart = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\n"
	anthropicPing  = "event: ping\ndata: {\"type\":\"ping\"}\n\n"
	anthropicText  = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n"
	anthropicStop  = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	overloaded     = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"
)

// sseUpstream streams parts, flushing after each and pausing between them.
func sseUpstream(t *testing.T, pause time.Duration, parts ...string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, part := range parts {
			w.Write([]byte(part))
			w.(http.Flusher).Flush()
			time.Sleep(pause)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

// streamFrom starts a stream request to the server, unread.
func (h *proxyHarness) streamFrom(t *testing.T, server *httptest.Server, id int64,
	timeoutSeconds float64) (*Response, *models.UpstreamRow) {
	t.Helper()
	upstream := &models.UpstreamRow{
		ID: id, Name: "channel", BaseURL: server.URL, ExtraHeaders: "{}",
		AutoWeightEnabled: 1, Enabled: 1, Weight: 100, TimeoutSeconds: timeoutSeconds,
	}
	h.registerUpstream(t, upstream)

	requestCtx := testRequestContext()
	requestCtx.Path = "messages"
	prepared, err := PrepareRequest(http.Header{}, upstream, requestCtx.Method, requestCtx.Path,
		"", nil, []byte(`{"model":"m","stream":true}`), requestCtx.LogBodyMaxBytes)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	response, err := ProxyRequest(context.Background(), h.deps, testPolicy(), upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	if !response.Streaming() {
		t.Fatal("the response is not a stream")
	}
	return response, upstream
}

type primedRow struct {
	status  int
	errText string
	retried bool
}

func (h *proxyHarness) onlyRow(t *testing.T) primedRow {
	t.Helper()
	h.waitForLogs(t, 1)
	var row primedRow
	if err := h.database.QueryRow(`SELECT status_code, COALESCE(error, ''), retried
        FROM request_logs`).Scan(&row.status, &row.errText, &row.retried); err != nil {
		t.Fatal(err)
	}
	return row
}

// Held back until content, then delivered whole and in order: what was held
// first, the rest as it arrives.
func TestAStreamIsHeldUntilItsFirstContent(t *testing.T) {
	harness := newProxyHarness(t)
	server := sseUpstream(t, 20*time.Millisecond, anthropicStart, anthropicPing, anthropicText, anthropicStop)
	response, _ := harness.streamFrom(t, server, 1, 0)

	holds := 0
	if !response.Prime(func() { holds++ }) {
		t.Fatal("a stream that showed content failed its prime")
	}
	if holds < 2 {
		t.Errorf("held back %d times before content, want one per preamble event", holds)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if want := anthropicStart + anthropicPing + anthropicText + anthropicStop; string(body) != want {
		t.Errorf("delivered %q, want the upstream's bytes in order", body)
	}
	if row := harness.onlyRow(t); row.status != 200 || row.retried {
		t.Errorf("logged %+v, want a 200 outcome", row)
	}
}

// A stream that fails before content goes to the caller as a failed attempt.
// Retried, it is logged as the attempt it was and charged to the channel.
func TestAStreamFailingBeforeContentIsAnAttempt(t *testing.T) {
	cases := []struct {
		name    string
		parts   []string
		timeout float64
		pause   time.Duration
		status  int
		errText string
	}{
		{"error event", []string{anthropicStart, overloaded}, 0, 0, 502,
			"upstream reported an error in the stream: overloaded_error: Overloaded"},
		{"stream ends", []string{anthropicStart}, 0, 0, 502,
			"upstream ended the stream before any content"},
		{"channel times out", []string{anthropicStart, anthropicText}, 0.2, 600 * time.Millisecond, 504, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			harness := newProxyHarness(t)
			response, upstream := harness.streamFrom(t, sseUpstream(t, tc.pause, tc.parts...), 1, tc.timeout)

			if response.Prime(nil) {
				t.Fatal("the prime succeeded")
			}
			response.Retry()

			row := harness.onlyRow(t)
			if row.status != tc.status || !row.retried || !strings.HasPrefix(row.errText, tc.errText) {
				t.Errorf("logged %+v, want a retried %d %q", row, tc.status, tc.errText)
			}
			score := harness.deps.AutoWeight.Snapshot(upstream.ID, upstream.Weight, true, testPolicy()).Score
			if score >= MaxHealthScore {
				t.Error("the channel was not charged")
			}
		})
	}
}

// When nothing replaces it, a failed stream is delivered as the channel sent
// it, error event and all, and logged as the outcome.
func TestAFailedStreamNothingReplacesIsDeliveredAsSent(t *testing.T) {
	harness := newProxyHarness(t)
	response, _ := harness.streamFrom(t, sseUpstream(t, 0, anthropicStart, overloaded), 1, 0)

	if response.Prime(nil) {
		t.Fatal("the prime succeeded")
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != anthropicStart+overloaded {
		t.Errorf("delivered %q, want the stream as sent", body)
	}
	if row := harness.onlyRow(t); row.status != 502 || row.retried {
		t.Errorf("logged %+v, want a 502 outcome", row)
	}
}

// Content first and an error after it: the client already has the content, so
// the stream is delivered, and the failure stays the stream's own.
func TestAStreamWithContentIsDeliveredWhateverFollows(t *testing.T) {
	for name, parts := range map[string][]string{
		"error after content":      {anthropicStart, anthropicText, overloaded},
		"complete without content": {"data: [DONE]\n\n"},
	} {
		t.Run(name, func(t *testing.T) {
			harness := newProxyHarness(t)
			response, _ := harness.streamFrom(t, sseUpstream(t, 0, parts...), 1, 0)
			if !response.Prime(nil) {
				t.Error("the prime failed")
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
		})
	}
}
