package proxy

import (
	"errors"
	"io"
	"net/http"
)

// FailureStage names where in one attempt's life it went wrong.
//
// The status code alone cannot answer that. A 502 is written when the dial
// failed, when the body died mid-read, and when an SSE stream closed before
// saying anything — three different faults with three different remedies, which
// the console previously had to guess apart from the error text. The values are
// part of the log API, so they are stable strings rather than an ordinal.
type FailureStage string

const (
	// FailureStageRequestBuild is a channel whose own configuration will not
	// produce a request: a base URL or header template the builder refuses.
	FailureStageRequestBuild FailureStage = "request_build"
	// FailureStageConnect is a failure before any response headers arrived.
	FailureStageConnect FailureStage = "connect"
	// FailureStageUpstreamStatus is a response whose headers arrived carrying a
	// status the gateway treats as a failure.
	FailureStageUpstreamStatus FailureStage = "upstream_status"
	// FailureStageFirstEvent is a 2xx SSE response that never produced a
	// complete event. The channel accepted the request and then said nothing,
	// which is the one failure that can still be switched away from
	// transparently: nothing has reached the client yet.
	FailureStageFirstEvent FailureStage = "first_event"
	// FailureStageResponseBody is a buffered response whose body failed after
	// its headers had arrived.
	FailureStageResponseBody FailureStage = "response_body"
	// FailureStageStream is a stream that failed after its first event. By then
	// the response is committed downstream, so this is never switchable.
	FailureStageStream FailureStage = "stream"
	// FailureStageClientCancelled is the client walking away. It is recorded as
	// a stage so the console can separate it from the channel's own faults,
	// which is what it already does with the 499 status.
	FailureStageClientCancelled FailureStage = "client_cancelled"
	// FailureStageNoRoute is a request that reached no channel at all.
	FailureStageNoRoute FailureStage = "no_route"
	// FailureStageRateLimited is a request every candidate channel's rate limit
	// refused.
	FailureStageRateLimited FailureStage = "rate_limited"
	// FailureStageGateway is a failure inside the gateway before an upstream was
	// involved: reading the downstream body, resolving a route, or the abort
	// fallback for a path that left no better record.
	FailureStageGateway FailureStage = "gateway"
)

// IsRetryableUpstreamStatus reports whether a status the upstream returned is
// worth giving to a different channel.
//
// The proxy used to retry every non-2xx response, which made a single wrong
// credential fan out across every channel serving the model: each one answered
// 401, each one was charged for it, and the caller waited through the whole
// list to receive the same refusal. A rejection that describes the request does
// not become correct on another channel.
//
// Retryable:
//   - every 5xx, because that is the channel reporting its own trouble
//   - 408 request timeout and 429 too many requests, which are about timing
//   - 425 too early, which asks for exactly one thing: send it again
//
// Not retryable, and specifically:
//   - 3xx, which is an instruction to the caller, not a failure. It is handed
//     back so the client can follow it.
//   - 401, 403 and 407, where the credential or the permission is the problem
//   - 400, 404, 409, 413, 422 and the rest of 4xx, which describe the request
func IsRetryableUpstreamStatus(status int) bool {
	if status >= 500 {
		return true
	}
	switch status {
	case http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests:
		return true
	default:
		return false
	}
}

// retryableFailureStages are the stages whose failures another channel may be
// given. A stage missing here is one where switching is either pointless or
// unsafe.
//
// FailureStageStream is deliberately absent: the client already has part of the
// answer, so replaying the request would deliver a second beginning in the
// middle of the first. FailureStageClientCancelled is absent because nobody is
// waiting for the result.
var retryableFailureStages = map[FailureStage]bool{
	FailureStageRequestBuild:   false,
	FailureStageConnect:        true,
	FailureStageUpstreamStatus: false, // decided by the status, see failureRetryable
	FailureStageFirstEvent:     true,
	FailureStageResponseBody:   true,
	FailureStageStream:         false,
}

// failureRetryable records the gateway's own verdict on one attempt's failure,
// for the log row.
//
// It is stored rather than derived later because it describes a decision that
// was made at the time: a policy edit must not rewrite the history of why a
// request stopped after one attempt.
func failureRetryable(stage FailureStage, status int32) bool {
	if stage == FailureStageUpstreamStatus {
		return IsRetryableUpstreamStatus(int(status))
	}
	return retryableFailureStages[stage]
}

// maxSSELeadBytes bounds what one attempt may hold back while waiting for a
// stream to prove itself.
//
// The gate exists to keep a dead stream from reaching the client, not to buffer
// an answer. A complete first event is a few hundred bytes on every provider
// this proxy speaks to, so this is far above the case it serves and only ever
// catches a channel emitting something other than events — comments, keep-alive
// padding, or a body that is not SSE despite its content type. Reaching it
// commits the response downstream rather than failing it: the channel is
// sending, so the client is better served by receiving it than by a failover.
//
// It is a constant rather than a setting because it bounds memory held per
// in-flight stream, which is not a policy an operator benefits from choosing.
const maxSSELeadBytes = 64 * 1024

// ErrNoFirstSSEEvent reports a 2xx SSE response that ended without ever
// completing an event.
var ErrNoFirstSSEEvent = errors.New("upstream closed the SSE stream before its first event")

// sseLead is what the first-event gate pulled off the upstream, along with the
// observation it has already folded those bytes into.
//
// The observation and capture travel with the bytes so the stream that
// continues from here does not observe them twice — the usage of a re-read
// event would be counted again, and the time-to-first-token would be measured
// from when the handler got around to reading rather than from when the event
// arrived.
type sseLead struct {
	bytes       []byte
	observation *sseObservation
	capture     *responseCapture
}

// awaitFirstSSEEvent reads from a 2xx SSE body until the stream proves itself.
//
// "Proves itself" is one complete event: at least one non-comment line closed
// by a blank line. That is the SSE framing rule, and it is deliberately not
// "the first visible token" — a reasoning model may think for minutes before
// emitting text, and holding its answer back that long to decide whether to
// keep it would be worse than any failover it enabled. A comment line does not
// count, because a keep-alive heartbeat proves only that something is connected.
//
// The wait is bounded twice over, and neither bound is new configuration: by the
// attempt's own timeout, which the caller has already armed and which this loop
// deliberately does not extend, and by maxSSELeadBytes. Reaching the byte cap
// returns success — the channel is sending, so what it sends is delivered.
func awaitFirstSSEEvent(body io.Reader, measure func() int32,
	logBodyMaxBytes int) (*sseLead, error) {
	lead := &sseLead{
		observation: &sseObservation{},
		capture:     newResponseCapture(logBodyMaxBytes),
	}

	buffer := make([]byte, 8*1024)
	for {
		read, err := body.Read(buffer)
		if read > 0 {
			chunk := buffer[:read]
			lead.bytes = append(lead.bytes, chunk...)
			lead.capture.push(chunk)
			lead.observation.observeChunk(chunk, measure)

			if lead.observation.firstEventSeen || len(lead.bytes) >= maxSSELeadBytes {
				return lead, nil
			}
		}
		if err != nil {
			if err == io.EOF {
				// The end of the body closes whatever event was open, so a
				// channel that sent a complete answer without a trailing blank
				// line still counts as having answered. Only a body that closed
				// with nothing in it is the failure this gate exists for.
				lead.observation.finish(measure)
				if lead.observation.firstEventSeen {
					return lead, nil
				}
				return lead, ErrNoFirstSSEEvent
			}
			return lead, err
		}
	}
}
