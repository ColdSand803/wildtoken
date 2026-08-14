package proxy

import (
	"context"
	"io"
	"sync"
	"time"
)

// sseStream forwards an upstream SSE body downstream while observing it, and
// writes the request log once the stream ends for any reason.
//
// The Rust implementation relied on Drop to log a client disconnect. Go has no
// destructor, so the same guarantee comes from the HTTP server always closing a
// response body: Close is what finalizes an abandoned stream.
type sseStream struct {
	upstream io.ReadCloser
	// requestCtx is the downstream request's context, which is what tells a
	// client walking away apart from an upstream failing.
	requestCtx  context.Context
	attempt     *attemptTimeout
	capture     *responseCapture
	observation *sseObservation
	start       time.Time

	upstreamStatus    int
	responseHeaders   map[string]string
	logBodyMaxBytes   int
	deps              Deps
	policy            AutoWeightPolicy
	autoWeightEnabled bool
	upstreamID        int64

	// mu guards entry, so a Close racing the final Read cannot log twice.
	mu    sync.Mutex
	entry *LogEntry
}

func newSSEStream(requestCtx context.Context, upstream io.ReadCloser, attempt *attemptTimeout,
	start time.Time, status int,
	responseHeaders map[string]string, logBodyMaxBytes int, entry LogEntry,
	deps Deps, policy AutoWeightPolicy, autoWeightEnabled bool, upstreamID int64) *sseStream {
	deps.Metrics.StartSSEStream()
	return &sseStream{
		upstream:          upstream,
		requestCtx:        requestCtx,
		attempt:           attempt,
		capture:           newResponseCapture(logBodyMaxBytes),
		observation:       &sseObservation{},
		start:             start,
		upstreamStatus:    status,
		responseHeaders:   responseHeaders,
		logBodyMaxBytes:   logBodyMaxBytes,
		deps:              deps,
		policy:            policy,
		autoWeightEnabled: autoWeightEnabled,
		upstreamID:        upstreamID,
		entry:             &entry,
	}
}

func (s *sseStream) Read(buffer []byte) (int, error) {
	read, err := s.upstream.Read(buffer)
	if read > 0 {
		// Progress restarts the attempt's clock, so a long answer is never cut
		// off for being long.
		s.attempt.extend()
		chunk := buffer[:read]
		s.capture.push(chunk)
		s.observation.observeChunk(chunk, s.measure)
		if s.observation.terminalEventSeen {
			s.finishComplete()
		}
	}

	switch {
	case err == io.EOF:
		s.finishComplete()
	case err != nil:
		s.finishInterrupted(err)
	}
	return read, err
}

// Close finalizes a stream the client abandoned before it completed.
func (s *sseStream) Close() error {
	s.mu.Lock()
	pending := s.entry != nil
	s.mu.Unlock()

	if pending {
		s.observation.finish(s.measure)
		if s.observation.terminalEventSeen {
			s.finishComplete()
		} else if s.finishLog(499,
			ptrTo("client disconnected before the SSE response completed")) {
			s.deps.Metrics.RecordSSEClientDisconnect()
		}
	}

	s.deps.Metrics.FinishSSEStream()
	err := s.upstream.Close()
	s.attempt.stop()
	return err
}

func (s *sseStream) measure() int32 {
	return int32(time.Since(s.start).Milliseconds())
}

func (s *sseStream) recordResponseHealth() {
	if s.upstreamStatus >= 200 && s.upstreamStatus < 300 {
		s.deps.AutoWeight.RecordSuccess(s.upstreamID, s.autoWeightEnabled, s.policy)
		return
	}
	s.deps.AutoWeight.RecordFailure(s.upstreamID, s.autoWeightEnabled, s.policy)
}

// finishComplete logs a stream that reached its end.
//
// The health score is recorded behind the same guard as the log, because a
// stream reaches here more than once: the terminal event finishes it, and so
// does the EOF that follows. Recording outside the guard scored one stream
// twice and let a penalised channel recover at double the configured rate.
func (s *sseStream) finishComplete() {
	if s.finishLog(int32(s.upstreamStatus), nil) {
		s.recordResponseHealth()
		s.deps.Metrics.RecordSSEComplete()
	}
}

// finishInterrupted logs a stream that stopped before its terminal event,
// attributing it to whichever side actually ended it.
//
// A client that walks away cancels the request context, and the read fails with
// a cancellation indistinguishable from an upstream one. Charging every such
// read to the channel is what let ordinary use — a user pressing escape on a
// long answer — drive a healthy channel's weight to zero and take it out of
// rotation, while leaving the disconnect metric reading zero.
func (s *sseStream) finishInterrupted(err error) {
	switch {
	case s.attempt.Expired():
		// The upstream went quiet for longer than the channel allows.
		s.deps.AutoWeight.RecordFailure(s.upstreamID, s.autoWeightEnabled, s.policy)
		message := err.Error()
		if s.finishLog(504, &message) {
			s.deps.Metrics.RecordSSEUpstreamError()
		}
	case s.requestCtx.Err() != nil:
		if s.finishLog(499,
			ptrTo("client disconnected before the SSE response completed")) {
			s.deps.Metrics.RecordSSEClientDisconnect()
		}
	default:
		s.deps.AutoWeight.RecordFailure(s.upstreamID, s.autoWeightEnabled, s.policy)
		message := err.Error()
		if s.finishLog(502, &message) {
			s.deps.Metrics.RecordSSEUpstreamError()
		}
	}
}

// finishLog writes the request log once. It reports false when another path
// already logged this stream.
func (s *sseStream) finishLog(statusCode int32, streamError *string) bool {
	s.mu.Lock()
	entry := s.entry
	s.entry = nil
	s.mu.Unlock()

	if entry == nil {
		return false
	}

	s.observation.finish(s.measure)
	usage := s.observation.usage
	responseSnapshot := SnapshotResponseWithBodyLength(s.upstreamStatus, s.responseHeaders,
		s.capture.bytes, s.capture.byteLength, s.logBodyMaxBytes)

	entry.StatusCode = &statusCode
	entry.ResponseReasoningEffort = s.observation.responseReasoningEffort
	entry.PromptTokens = usage.PromptTokens
	entry.CompletionTokens = usage.CompletionTokens
	entry.TotalTokens = usage.TotalTokens
	entry.PromptCachedTokens = usage.PromptCachedTokens
	entry.CacheCreationTokens = usage.CacheCreationTokens
	entry.CompletionReasoningTokens = usage.CompletionReasoningTokens
	entry.FirstTokenMs = s.observation.firstTokenMs
	entry.DurationMs = elapsedMs(s.start)
	entry.Error = streamError
	entry.UpstreamResponse = responseSnapshot
	entry.DownstreamResponse = responseSnapshot

	s.deps.LogWriter.Schedule(*entry)
	return true
}

func ptrTo[T any](value T) *T { return &value }
