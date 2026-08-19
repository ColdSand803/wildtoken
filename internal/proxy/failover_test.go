package proxy

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// loggedFailure is one attempt's failure classification as it was persisted.
type loggedFailure struct {
	statusCode  sql.NullInt64
	stage       sql.NullString
	retryable   sql.NullBool
	firstToken  sql.NullInt64
	totalTokens sql.NullInt64
}

// readFailure drains the writer and returns the row the attempt wrote.
func readFailure(t *testing.T, harness *proxyHarness) loggedFailure {
	t.Helper()
	harness.deps.LogWriter.Close()

	var failure loggedFailure
	err := harness.database.QueryRow(`SELECT status_code, failure_stage, failure_retryable,
	    first_token_ms, total_tokens FROM request_logs ORDER BY id DESC LIMIT 1`).Scan(
		&failure.statusCode, &failure.stage, &failure.retryable,
		&failure.firstToken, &failure.totalTokens)
	if err != nil {
		t.Fatalf("read failure: %v", err)
	}
	return failure
}

// streamRequestContext asks for the failover gate, which is what an attempt with
// budget left looks like when the handler builds it.
func streamRequestContext(failoverEligible bool) RequestContext {
	requestCtx := testRequestContext()
	requestCtx.RequestUID = "gate01"
	requestCtx.ReceivedAt = time.Now()
	requestCtx.FailoverEligible = failoverEligible
	return requestCtx
}

// sseServer starts an event-stream upstream whose body the caller writes.
func sseServer(write func(w http.ResponseWriter, flusher http.Flusher)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		flusher.Flush()
		write(w, flusher)
	}))
}

// TestRetryableStatusMatrix is the matrix the checklist asks to be encoded in a
// test, in one place, so changing the policy has to come here and say which cell
// is changing.
func TestRetryableStatusMatrix(t *testing.T) {
	for status, want := range map[int]bool{
		// The channel reporting its own trouble.
		500: true, 502: true, 503: true, 504: true, 529: true,
		// Timing, not correctness.
		408: true, 425: true, 429: true,
		// The credential or the permission is the problem. Retrying these is how
		// one wrong key came to be tried against every channel serving the model.
		401: false, 403: false, 407: false,
		// The request describes itself wrongly, and another channel reads it the
		// same way.
		400: false, 404: false, 409: false, 413: false, 422: false,
		// An instruction to the caller, not a failure.
		301: false, 302: false, 307: false, 308: false,
		// Success is not something to retry.
		200: false, 204: false,
	} {
		if got := IsRetryableUpstreamStatus(status); got != want {
			t.Errorf("IsRetryableUpstreamStatus(%d) = %v, want %v", status, got, want)
		}
	}
}

// TestFailureRetryableFollowsStageAndStatus covers the pairing the log stores:
// the stage decides, except at upstream_status where the status does.
func TestFailureRetryableFollowsStageAndStatus(t *testing.T) {
	for _, testCase := range []struct {
		stage  FailureStage
		status int32
		want   bool
	}{
		{FailureStageConnect, 502, true},
		{FailureStageFirstEvent, 502, true},
		{FailureStageFirstEvent, 504, true},
		{FailureStageResponseBody, 502, true},
		// After the first event the client already holds the beginning of an
		// answer, so a replay would splice a second beginning into the middle of
		// the first.
		{FailureStageStream, 502, false},
		{FailureStageStream, 504, false},
		// Nobody is waiting for a further attempt.
		{FailureStageClientCancelled, 499, false},
		// A channel that cannot build a request fails the next one the same way.
		{FailureStageRequestBuild, 502, false},
		// Here the status is the whole story.
		{FailureStageUpstreamStatus, 429, true},
		{FailureStageUpstreamStatus, 503, true},
		{FailureStageUpstreamStatus, 401, false},
		{FailureStageUpstreamStatus, 302, false},
	} {
		if got := failureRetryable(testCase.stage, testCase.status); got != testCase.want {
			t.Errorf("failureRetryable(%s, %d) = %v, want %v",
				testCase.stage, testCase.status, got, testCase.want)
		}
	}
}

// TestSuccessLeavesFailureFieldsNull keeps a success from carrying a stage. A
// "none" value here would have to be excluded from every console filter by hand,
// and the first place that forgot would report successes as failures.
func TestSuccessLeavesFailureFieldsNull(t *testing.T) {
	var entry LogEntry
	entry.SetFailure(FailureStageConnect, 502)
	if entry.FailureStage == nil || entry.FailureRetryable == nil {
		t.Fatal("SetFailure left the pair unset")
	}
	entry.SetFailure("", 200)
	if entry.FailureStage != nil || entry.FailureRetryable != nil {
		t.Errorf("an empty stage left %v/%v, want both cleared",
			entry.FailureStage, entry.FailureRetryable)
	}
}

// TestSSEHeaderWithoutAnyEventIsAFailure is the case the gate exists for: a
// channel that accepts every request with a 200 and then streams nothing. Before
// it, the retry loop saw the 2xx, stopped, and left the client waiting out the
// whole timeout on a stream that was never going to speak.
func TestSSEHeaderWithoutAnyEventIsAFailure(t *testing.T) {
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		// The body closes with nothing in it.
	})
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err == nil {
		response.Body.Close()
		t.Fatal("a 2xx stream that produced no event was reported as a success")
	}

	failure := readFailure(t, harness)
	// The logged status says who ended the request, not what the encouraging
	// header claimed. Rows reading 200 for streams that delivered nothing are how
	// these came to show up in the console as successes.
	if failure.statusCode.Int64 != 502 {
		t.Errorf("status = %d, want 502 for a stream that said nothing", failure.statusCode.Int64)
	}
	if failure.stage.String != string(FailureStageFirstEvent) {
		t.Errorf("stage = %q, want %s", failure.stage.String, FailureStageFirstEvent)
	}
	if !failure.retryable.Valid || !failure.retryable.Bool {
		t.Error("a pre-first-event failure was not recorded as retryable")
	}

	// The channel is charged: it answered a request with nothing, which is the
	// behaviour that should take it out of rotation.
	health := harness.deps.AutoWeight.Snapshot(upstream.ID, 100, true, testPolicy())
	if health.Score >= MaxHealthScore {
		t.Errorf("health score = %d, want it reduced", health.Score)
	}
}

// TestSSEStreamProvenByOneEventIsHandedOver checks the other half: a working
// stream is let through, the bytes the gate already read are delivered, and what
// it observed is not counted twice.
func TestSSEStreamProvenByOneEventIsHandedOver(t *testing.T) {
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
		flusher.Flush()
		w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"usage\":" +
			"{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n"))
		flusher.Flush()
	})
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	response.Body.Close()

	// The gate consumed the first event off the upstream. Unreplayed, the client
	// would receive an answer missing its beginning.
	if !strings.Contains(string(body), "response.output_text.delta") {
		t.Errorf("the event the gate read never reached the client: %q", string(body))
	}

	failure := readFailure(t, harness)
	if failure.statusCode.Int64 != http.StatusOK {
		t.Errorf("status = %d, want 200", failure.statusCode.Int64)
	}
	if failure.stage.Valid {
		t.Errorf("a completed stream carries stage %q, want NULL", failure.stage.String)
	}
	// Observed once. The lead travels with its own observation precisely so that
	// re-reading those bytes cannot report this usage a second time.
	if failure.totalTokens.Int64 != 15 {
		t.Errorf("total tokens = %d, want 15 counted exactly once", failure.totalTokens.Int64)
	}
}

// TestStreamFailingAfterItsFirstEventIsNotRetryable is the boundary the design
// turns on. Once bytes are committed downstream there is nothing to switch to.
func TestStreamFailingAfterItsFirstEventIsNotRetryable(t *testing.T) {
	released := make(chan struct{})
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
		flusher.Flush()
		// Then the upstream goes quiet until its attempt window closes.
		<-released
	})
	defer server.Close()
	defer close(released)

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	// Short enough that the silence after the first event runs the clock out.
	upstream.TimeoutSeconds = 0.4

	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("the gate rejected a stream that did produce an event: %v", err)
	}

	buffer := make([]byte, 256)
	for {
		if _, readErr := response.Body.Read(buffer); readErr != nil {
			break
		}
	}
	response.Body.Close()

	failure := readFailure(t, harness)
	if failure.statusCode.Int64 != 504 {
		t.Errorf("status = %d, want 504 for an upstream that went quiet", failure.statusCode.Int64)
	}
	if failure.stage.String != string(FailureStageStream) {
		t.Errorf("stage = %q, want %s: the answer had already started",
			failure.stage.String, FailureStageStream)
	}
	if !failure.retryable.Valid || failure.retryable.Bool {
		t.Error("a post-first-event failure was recorded as retryable")
	}
}

// TestGateTimesOutOnASilentStream covers the timeout cell: the channel accepted
// the request and then said nothing until its own clock ran out.
func TestGateTimesOutOnASilentStream(t *testing.T) {
	released := make(chan struct{})
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		<-released
	})
	defer server.Close()
	defer close(released)

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	upstream.TimeoutSeconds = 0.4

	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	startedAt := time.Now()
	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err == nil {
		response.Body.Close()
		t.Fatal("a stream that never spoke was reported as a success")
	}
	// The gate deliberately does not extend the attempt's clock, so the wait is
	// bounded by the channel's own timeout instead of running on indefinitely.
	if elapsed := time.Since(startedAt); elapsed > 3*time.Second {
		t.Errorf("the gate waited %v, want it bounded by the channel's 0.4s", elapsed)
	}

	failure := readFailure(t, harness)
	if failure.statusCode.Int64 != 504 {
		t.Errorf("status = %d, want 504", failure.statusCode.Int64)
	}
	if failure.stage.String != string(FailureStageFirstEvent) {
		t.Errorf("stage = %q, want %s", failure.stage.String, FailureStageFirstEvent)
	}
	if !failure.retryable.Bool {
		t.Error("a first-event timeout was recorded as unretryable")
	}
}

// TestClientCancellationDuringTheGateIsNotChargedToTheChannel keeps the one
// outcome the channel is not answerable for out of its health score, and out of
// the retryable class: nobody is waiting for another attempt.
func TestClientCancellationDuringTheGateIsNotChargedToTheChannel(t *testing.T) {
	released := make(chan struct{})
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		<-released
	})
	defer server.Close()
	defer close(released)

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	// Long enough that the cancellation, not the clock, is what ends this.
	upstream.TimeoutSeconds = 30

	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	ctx, cancel := context.WithCancel(context.Background())
	// Cancelled while the gate is waiting, which is where a client pressing
	// escape on a slow model actually lands.
	go func() {
		time.Sleep(150 * time.Millisecond)
		cancel()
	}()

	response, err := ProxyRequest(ctx, harness.deps, testPolicy(), &upstream, requestCtx, prepared)
	if err == nil {
		response.Body.Close()
		t.Fatal("the cancelled request reported success")
	}

	failure := readFailure(t, harness)
	if failure.statusCode.Int64 != 499 {
		t.Errorf("status = %d, want 499 for a client that walked away", failure.statusCode.Int64)
	}
	if failure.stage.String != string(FailureStageClientCancelled) {
		t.Errorf("stage = %q, want %s", failure.stage.String, FailureStageClientCancelled)
	}
	if failure.retryable.Bool {
		t.Error("a client cancellation was recorded as retryable")
	}

	// Charging this is what let ordinary use drive a healthy channel to zero.
	health := harness.deps.AutoWeight.Snapshot(upstream.ID, 100, true, testPolicy())
	if health.Score != MaxHealthScore {
		t.Errorf("health score = %d, want %d after a client cancellation",
			health.Score, MaxHealthScore)
	}
}

// TestGateIsSkippedWhenNoAttemptCouldFollow keeps the last attempt behaving as it
// did before the gate existed. Holding a response back to decide something nobody
// can act on would only add latency.
func TestGateIsSkippedWhenNoAttemptCouldFollow(t *testing.T) {
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {})
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	requestCtx := streamRequestContext(false)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("the ineligible attempt was gated anyway: %v", err)
	}
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatalf("read stream: %v", err)
	}
	response.Body.Close()

	// The stream is handed over on its headers, and the empty body that follows is
	// recorded the way it always was: the EOF completes the stream.
	failure := readFailure(t, harness)
	if failure.statusCode.Int64 != http.StatusOK {
		t.Errorf("status = %d, want the pre-gate behaviour of 200", failure.statusCode.Int64)
	}
}

// TestGateCommitsOnceTheLeadBufferFills keeps a channel that sends something
// other than events from being held indefinitely. It is sending, so what it
// sends is delivered.
func TestGateCommitsOnceTheLeadBufferFills(t *testing.T) {
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		// Comment lines only, and never a blank one, so no event is ever
		// completed and only the byte cap can end the wait.
		padding := strings.Repeat("x", 1024)
		for written := 0; written < maxSSELeadBytes+8*1024; written += len(padding) + 3 {
			w.Write([]byte(": " + padding + "\n"))
			flusher.Flush()
		}
	})
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	upstream.TimeoutSeconds = 10

	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("the byte cap did not release the gate: %v", err)
	}
	delivered, err := io.Copy(io.Discard, response.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	response.Body.Close()

	// Everything the gate buffered is still delivered, which is the point of
	// committing rather than failing over.
	if delivered < int64(maxSSELeadBytes) {
		t.Errorf("delivered %d bytes, want at least the %d the gate held",
			delivered, maxSSELeadBytes)
	}
}

// TestCommentOnlyStreamDoesNotCountAsAnEvent is why the gate reads event framing
// rather than counting bytes: a channel that only breathes must not pass for one
// that answered.
func TestCommentOnlyStreamDoesNotCountAsAnEvent(t *testing.T) {
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		w.Write([]byte(": keep-alive\n\n"))
		flusher.Flush()
		w.Write([]byte(": keep-alive\n\n"))
		flusher.Flush()
	})
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err == nil {
		response.Body.Close()
		t.Fatal("a stream of comments was accepted as having answered")
	}

	failure := readFailure(t, harness)
	if failure.stage.String != string(FailureStageFirstEvent) {
		t.Errorf("stage = %q, want %s", failure.stage.String, FailureStageFirstEvent)
	}
}

// TestEventWithoutATrailingBlankLineStillCounts keeps the gate from abandoning a
// channel that answered in full and closed without the final separator, which is
// how the pre-gate code already treated an EOF.
func TestEventWithoutATrailingBlankLineStillCounts(t *testing.T) {
	server := sseServer(func(w http.ResponseWriter, flusher http.Flusher) {
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}"))
	})
	defer server.Close()

	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, server.URL)
	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("an unterminated but complete answer was abandoned: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	response.Body.Close()
	if len(body) == 0 {
		t.Error("the lead was not replayed downstream")
	}

	failure := readFailure(t, harness)
	if failure.statusCode.Int64 != http.StatusOK {
		t.Errorf("status = %d, want 200", failure.statusCode.Int64)
	}
	// The token was seen while the gate held those bytes, so its timing comes
	// from when it arrived and not from when the handler read it back.
	if !failure.firstToken.Valid {
		t.Error("first_token_ms is NULL for a stream whose only token the gate read")
	}
}

// TestNonRetryableStatusIsLoggedWithItsStage covers the 401/403 cell at this
// layer: the response comes back as it is, and the row says the status is the
// whole story.
func TestNonRetryableStatusIsLoggedWithItsStage(t *testing.T) {
	for name, status := range map[string]int{
		"unauthorized": http.StatusUnauthorized,
		"forbidden":    http.StatusForbidden,
	} {
		t.Run(name, func(t *testing.T) {
			server := statusServer(status, `{"error":{"message":"nope"}}`)
			defer server.Close()

			failure := proxyOnceForFailure(t, server.URL)
			if failure.statusCode.Int64 != int64(status) {
				t.Errorf("status = %d, want the upstream's %d",
					failure.statusCode.Int64, status)
			}
			if failure.stage.String != string(FailureStageUpstreamStatus) {
				t.Errorf("stage = %q, want %s",
					failure.stage.String, FailureStageUpstreamStatus)
			}
			if failure.retryable.Bool {
				t.Errorf("status %d was recorded as retryable", status)
			}
		})
	}
}

// TestRetryableStatusIsLoggedAsRetryable is the 429 and 5xx cell: the same path,
// the opposite verdict, so the console can tell an attempt that was worth
// repeating from one that was not.
func TestRetryableStatusIsLoggedAsRetryable(t *testing.T) {
	for name, status := range map[string]int{
		"rate limited": http.StatusTooManyRequests,
		"bad gateway":  http.StatusBadGateway,
		"overloaded":   529,
	} {
		t.Run(name, func(t *testing.T) {
			server := statusServer(status, `{"error":{"message":"later"}}`)
			defer server.Close()

			failure := proxyOnceForFailure(t, server.URL)
			if failure.stage.String != string(FailureStageUpstreamStatus) {
				t.Errorf("stage = %q, want %s",
					failure.stage.String, FailureStageUpstreamStatus)
			}
			if !failure.retryable.Valid || !failure.retryable.Bool {
				t.Errorf("status %d was not recorded as retryable", status)
			}
		})
	}
}

func statusServer(status int, body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(body))
	}))
}

// proxyOnceForFailure forwards one buffered request and returns how it was logged.
func proxyOnceForFailure(t *testing.T, baseURL string) loggedFailure {
	t.Helper()
	harness := newProxyHarness(t)
	upstream := timingUpstream(t, harness, baseURL)
	requestCtx := streamRequestContext(true)
	prepared := prepareFor(t, &upstream, requestCtx)

	response, err := ProxyRequest(context.Background(), harness.deps, testPolicy(),
		&upstream, requestCtx, prepared)
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	return readFailure(t, harness)
}

// TestAwaitFirstSSEEventRecognisesOneCompleteEvent pins the unit the gate waits
// for, away from the HTTP machinery: one non-comment line closed by a blank one.
func TestAwaitFirstSSEEventRecognisesOneCompleteEvent(t *testing.T) {
	body := "data: first\n\ndata: second\n\ndata: third\n\n"
	lead, err := awaitFirstSSEEvent(strings.NewReader(body), func() int32 { return 1 }, 4096)
	if err != nil {
		t.Fatalf("await: %v", err)
	}
	if !lead.observation.firstEventSeen {
		t.Error("a complete event was not recognised")
	}
	// What it read has to be replayable, so it must never hold more than the body
	// actually contained.
	if len(lead.bytes) > len(body) {
		t.Errorf("buffered %d bytes of a %d byte body", len(lead.bytes), len(body))
	}
}

// TestAwaitFirstSSEEventReportsAnEmptyBody names the error the caller switches
// on, so a change of wording cannot quietly turn this into a generic read failure.
func TestAwaitFirstSSEEventReportsAnEmptyBody(t *testing.T) {
	lead, err := awaitFirstSSEEvent(strings.NewReader(""), func() int32 { return 0 }, 4096)
	if err != ErrNoFirstSSEEvent {
		t.Fatalf("err = %v, want ErrNoFirstSSEEvent", err)
	}
	if len(lead.bytes) != 0 {
		t.Errorf("buffered %d bytes of an empty body", len(lead.bytes))
	}
}
