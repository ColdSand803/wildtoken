package handlers

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// failureRow is one attempt as the console will read it back.
type failureRow struct {
	attemptIndex sql.NullInt64
	statusCode   sql.NullInt64
	upstreamName sql.NullString
	stage        sql.NullString
	retryable    sql.NullBool
}

func readFailureRows(t *testing.T, database *sql.DB) []failureRow {
	t.Helper()
	rows, err := database.Query(`SELECT attempt_index, status_code, upstream_name,
	    failure_stage, failure_retryable FROM request_logs ORDER BY id`)
	if err != nil {
		t.Fatalf("query attempts: %v", err)
	}
	defer rows.Close()

	var attempts []failureRow
	for rows.Next() {
		var attempt failureRow
		if err := rows.Scan(&attempt.attemptIndex, &attempt.statusCode,
			&attempt.upstreamName, &attempt.stage, &attempt.retryable); err != nil {
			t.Fatalf("scan attempt: %v", err)
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return attempts
}

// silentSSEUpstream answers with an event-stream header and then sends nothing,
// which is the failure the first-event gate was added for: encouraging headers
// over a stream that never speaks.
func silentSSEUpstream(t *testing.T) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

// answeringSSEUpstream streams one delta and a terminal event.
func answeringSSEUpstream(t *testing.T) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"))
		flusher.Flush()
		w.Write([]byte("data: [DONE]\n\n"))
		flusher.Flush()
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

// statusUpstream answers with a fixed status and counts its hits, so a test can
// assert that a non-retryable status was not tried a second time.
func statusUpstream(t *testing.T, status int) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(`{"error":{"message":"refused"}}`))
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

// noBackoffState removes the same-channel retry pause, which would otherwise hold
// each of these tests for a second without changing what they assert.
func noBackoffState(t *testing.T) *appstate.State {
	t.Helper()
	state := proxyRateLimitState(t)
	settings := state.Runtime.Get()
	settings.SameUpstreamRetryIntervalMs = 0
	state.Runtime.Set(settings)
	// Wired as the server wires it, so failover also exercises the latency
	// samples the least-latency strategy reads.
	state.Latency = proxy.NewLatencyTracker()
	return state
}

// TestSilentSSEChannelFailsOverBeforeTheFirstEvent is P1-1 end to end: the
// channel answers 200 and streams nothing, the gate catches it before any byte
// reaches the client, and the request is served by the next channel.
func TestSilentSSEChannelFailsOverBeforeTheFirstEvent(t *testing.T) {
	state := noBackoffState(t)
	silent, silentHits := silentSSEUpstream(t)
	answering, answeringHits := answeringSSEUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "silent", silent.URL, 999, nil)
	createChannel(t, state, "answering", answering.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequest(router, "caller-token")
	if response.Code != http.StatusOK {
		t.Fatalf("got %d, want the failover to succeed: %s", response.Code, response.Body.String())
	}
	// The client receives the second channel's answer, and only that one. The
	// first channel's headers were held back precisely so this body could not
	// begin with a broken stream.
	if !strings.Contains(response.Body.String(), "hello") {
		t.Errorf("body = %q, want the answering channel's stream", response.Body.String())
	}
	if silentHits.Load() != 1 || answeringHits.Load() != 1 {
		t.Errorf("hits = (silent %d, answering %d), want one each",
			silentHits.Load(), answeringHits.Load())
	}

	state.LogWriter.Close()
	attempts := readFailureRows(t, state.DB)
	if len(attempts) != 2 {
		t.Fatalf("wrote %d rows, want one per attempt", len(attempts))
	}

	failed, succeeded := attempts[0], attempts[1]
	if failed.upstreamName.String != "silent" {
		t.Errorf("first attempt hit %q, want the silent channel", failed.upstreamName.String)
	}
	if failed.stage.String != string(proxy.FailureStageFirstEvent) {
		t.Errorf("stage = %q, want %s", failed.stage.String, proxy.FailureStageFirstEvent)
	}
	if !failed.retryable.Valid || !failed.retryable.Bool {
		t.Error("the attempt that was in fact retried is not recorded as retryable")
	}
	if failed.statusCode.Int64 != 502 {
		t.Errorf("status = %d, want 502 rather than the upstream's encouraging 200",
			failed.statusCode.Int64)
	}

	if succeeded.upstreamName.String != "answering" {
		t.Errorf("second attempt hit %q, want the other channel", succeeded.upstreamName.String)
	}
	if succeeded.stage.Valid {
		t.Errorf("the successful attempt carries stage %q, want NULL", succeeded.stage.String)
	}
	if succeeded.statusCode.Int64 != http.StatusOK {
		t.Errorf("status = %d, want 200", succeeded.statusCode.Int64)
	}
}

// TestUnauthorizedChannelIsNotRetried is the 401 cell of the matrix at the retry
// loop. Trying another channel with the same rejected credential is how one wrong
// key came to be spread across every channel serving the model.
func TestUnauthorizedChannelIsNotRetried(t *testing.T) {
	for name, status := range map[string]int{
		"unauthorized": http.StatusUnauthorized,
		"forbidden":    http.StatusForbidden,
	} {
		t.Run(name, func(t *testing.T) {
			state := noBackoffState(t)
			refusing, refusingHits := statusUpstream(t, status)
			answering, answeringHits := answeringSSEUpstream(t)

			insertCallerToken(t, state.DB, "caller-token")
			createChannel(t, state, "refusing", refusing.URL, 999, nil)
			createChannel(t, state, "answering", answering.URL, 100, nil)
			router := proxyRateLimitRouter(state)

			response := sendProxyRequest(router, "caller-token")
			if response.Code != status {
				t.Fatalf("got %d, want the upstream's %d passed through",
					response.Code, status)
			}
			if refusingHits.Load() != 1 {
				t.Errorf("the refusing channel was hit %d times, want once",
					refusingHits.Load())
			}
			if answeringHits.Load() != 0 {
				t.Errorf("the credential failure was retried against another channel (%d hits)",
					answeringHits.Load())
			}

			state.LogWriter.Close()
			attempts := readFailureRows(t, state.DB)
			if len(attempts) != 1 {
				t.Fatalf("wrote %d rows, want the single attempt", len(attempts))
			}
			if attempts[0].stage.String != string(proxy.FailureStageUpstreamStatus) {
				t.Errorf("stage = %q, want %s",
					attempts[0].stage.String, proxy.FailureStageUpstreamStatus)
			}
			if attempts[0].retryable.Bool {
				t.Error("the credential failure is recorded as retryable")
			}
		})
	}
}

// TestRateLimitedChannelIsRetriedElsewhere is the 429 cell: the channel is busy,
// not wrong, so another one is tried.
func TestRateLimitedChannelIsRetriedElsewhere(t *testing.T) {
	state := noBackoffState(t)
	busy, busyHits := statusUpstream(t, http.StatusTooManyRequests)
	answering, answeringHits := answeringSSEUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "busy", busy.URL, 999, nil)
	createChannel(t, state, "answering", answering.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequest(router, "caller-token")
	if response.Code != http.StatusOK {
		t.Fatalf("got %d, want the failover to succeed: %s", response.Code, response.Body.String())
	}
	if busyHits.Load() != 1 || answeringHits.Load() != 1 {
		t.Errorf("hits = (busy %d, answering %d), want one each",
			busyHits.Load(), answeringHits.Load())
	}

	state.LogWriter.Close()
	attempts := readFailureRows(t, state.DB)
	if len(attempts) != 2 {
		t.Fatalf("wrote %d rows, want one per attempt", len(attempts))
	}
	if !attempts[0].retryable.Valid || !attempts[0].retryable.Bool {
		t.Error("the 429 is not recorded as retryable")
	}
}

// TestFailoverPrefersAChannelThatHasNotFailedYet checks the two-pass selection.
// Re-drawing the channel that just failed spends the retry budget on the same
// failure, and with weights involved that is the likely draw.
func TestFailoverPrefersAChannelThatHasNotFailedYet(t *testing.T) {
	state := noBackoffState(t)
	broken := failingUpstream(t)
	answering, answeringHits := answeringSSEUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	// Same priority and weight, so weighted selection alone would draw either.
	createChannel(t, state, "broken", broken.URL, 100, nil)
	createChannel(t, state, "answering", answering.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	// Repeated because the first choice is random: what must hold every time is
	// that the retry does not land on the channel that already failed.
	for i := 0; i < 12; i++ {
		if response := sendProxyRequest(router, "caller-token"); response.Code != http.StatusOK {
			t.Fatalf("request %d returned %d, want the retry to reach the working channel: %s",
				i, response.Code, response.Body.String())
		}
	}
	if answeringHits.Load() < 12 {
		t.Errorf("the working channel served %d of 12 requests", answeringHits.Load())
	}
}

// TestSingleChannelLastAttemptPreservesHeaderSuccess keeps a one-channel
// deployment's final attempt compatible with the pre-gate behaviour. The first
// attempt is eligible and fails over; there is nothing after the second attempt,
// so holding its 2xx SSE header would make a decision that cannot be acted on.
func TestSingleChannelLastAttemptPreservesHeaderSuccess(t *testing.T) {
	state := noBackoffState(t)
	silent, silentHits := silentSSEUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "only", silent.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequest(router, "caller-token")
	if response.Code != http.StatusOK {
		t.Fatalf("got %d, want the final pre-gate-style 200: %s",
			response.Code, response.Body.String())
	}
	// The default budget is one retry. The first attempt is classified as a
	// retryable first-event failure; the second preserves the old header-success
	// behaviour because no further channel could be selected.
	if silentHits.Load() != 2 {
		t.Errorf("the only channel was hit %d times, want 2", silentHits.Load())
	}

	state.LogWriter.Close()
	attempts := readFailureRows(t, state.DB)
	if len(attempts) != 2 {
		t.Fatalf("wrote %d rows, want one per attempt", len(attempts))
	}
	if attempts[0].stage.String != string(proxy.FailureStageFirstEvent) ||
		!attempts[0].retryable.Bool {
		t.Errorf("first attempt = %+v, want a retryable first-event failure", attempts[0])
	}
	if attempts[1].statusCode.Int64 != http.StatusOK || attempts[1].stage.Valid {
		t.Errorf("last attempt = %+v, want the legacy successful header outcome", attempts[1])
	}
}

// TestStreamThatBreaksAfterItsFirstEventIsNotFailedOver is the boundary at the
// handler: bytes are already downstream, so a second channel's answer would be
// spliced onto the middle of the first.
func TestStreamThatBreaksAfterItsFirstEventIsNotFailedOver(t *testing.T) {
	state := noBackoffState(t)
	var brokenHits atomic.Int64
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		brokenHits.Add(1)
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"half\"}}]}\n\n"))
		flusher.Flush()
		// Closes without a terminal event: the answer is cut off mid-flight.
	}))
	t.Cleanup(broken.Close)
	answering, answeringHits := answeringSSEUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "broken", broken.URL, 999, nil)
	createChannel(t, state, "answering", answering.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequest(router, "caller-token")
	// The stream was committed on its first event, so the partial answer is what
	// the client gets — and it gets it once.
	if !strings.Contains(response.Body.String(), "half") {
		t.Errorf("body = %q, want the committed partial answer", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "hello") {
		t.Error("a second channel's answer was appended to a stream already in flight")
	}
	if brokenHits.Load() != 1 {
		t.Errorf("the broken channel was hit %d times, want once", brokenHits.Load())
	}
	if answeringHits.Load() != 0 {
		t.Errorf("a committed stream was failed over (%d hits on the other channel)",
			answeringHits.Load())
	}
}
