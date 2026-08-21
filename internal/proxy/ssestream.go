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

	// mu guards entry so that whichever path reaches the end of the stream first
	// is the one that logs it: the terminal event, the EOF after it, a failed
	// read, or Close.
	//
	// It guards entry only. Everything else here is written from the read loop
	// and read again in Close, which is safe because both run in the handler's
	// own goroutine — a caller that closed the body from another one would be
	// racing the fields this lock does not cover.
	mu    sync.Mutex
	entry *LogEntry

	// pending is what the first-event gate already pulled off the upstream. It
	// is handed to the client before the upstream is read again, and it is
	// deliberately not re-observed: those bytes are already folded into
	// observation, so observing them twice would count one event's usage twice
	// and re-time the first token to when the handler got around to reading it.
	pending []byte
}

func newSSEStream(requestCtx context.Context, upstream io.ReadCloser, attempt *attemptTimeout,
	start time.Time, status int,
	responseHeaders map[string]string, logBodyMaxBytes int, entry LogEntry,
	deps Deps, policy AutoWeightPolicy, autoWeightEnabled bool, upstreamID int64,
	lead *sseLead) *sseStream {
	deps.Metrics.StartSSEStream()
	stream := &sseStream{
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
	if lead != nil {
		stream.pending = lead.bytes
		stream.observation = lead.observation
		stream.capture = lead.capture
	}
	return stream
}

func (s *sseStream) Read(buffer []byte) (int, error) {
	// The gate's bytes are delivered first, and only from memory: a stream whose
	// whole answer fit in the lead is complete before the upstream is touched
	// again, and reading it here would block on a body that has nothing left.
	if len(s.pending) > 0 {
		read := copy(buffer, s.pending)
		s.pending = s.pending[read:]
		if len(s.pending) == 0 && s.observation.terminalEventSeen {
			s.finishComplete()
		}
		return read, nil
	}

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
			ptrTo("client disconnected before the SSE response completed"),
			FailureStageClientCancelled) {
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

// recordResponseHealth credits a stream that ran to its end.
//
// A stream is only built for a 2xx response, so reaching the end of one is
// always a success. The status is not re-examined here: doing so implied this
// type could carry a failing status, which it cannot, and left a branch that
// looked covered while being unreachable.
func (s *sseStream) recordResponseHealth() {
	s.deps.AutoWeight.RecordSuccess(s.upstreamID, s.autoWeightEnabled, s.policy)
}

// finishComplete logs a stream that reached its end.
//
// The health score is recorded behind the same guard as the log, because a
// stream reaches here more than once: the terminal event finishes it, and so
// does the EOF that follows. Recording outside the guard scored one stream
// twice and let a penalised channel recover at double the configured rate.
func (s *sseStream) finishComplete() {
	if s.finishLog(int32(s.upstreamStatus), nil, "") {
		s.recordResponseHealth()
		s.deps.Metrics.RecordSSEComplete()
		// A stream that ran to its end is a latency sample: the channel answered,
		// and how soon it started is what least-latency routing compares.
		s.deps.Latency.Record(s.upstreamID, s.observation.firstTokenMs)
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
	// Client aborts are the one outcome the channel is not answerable for. The
	// health score, like the log, is recorded behind finishLog's guard: a stream
	// that already finished on its terminal event can still fail the read that
	// follows, and scoring outside the guard charged that channel for a stream
	// the log had already recorded as a success.
	message := err.Error()
	// The stage separates a stream that died with the answer already flowing from
	// one that never said anything. Only the second could have been switched
	// away from, and by the time a read fails here the first-event gate has
	// already had its chance — so a stream stage is a fault nobody can retry,
	// which is exactly what the console needs to show.
	stage := s.failureStage()
	switch {
	case s.attempt.Expired():
		// The upstream went quiet for longer than the channel allows.
		if s.finishLog(504, &message, stage) {
			s.deps.AutoWeight.RecordFailure(s.upstreamID, s.autoWeightEnabled, s.policy)
			s.deps.Metrics.RecordSSEUpstreamError()
		}
	case s.requestCtx.Err() != nil:
		if s.finishLog(499,
			ptrTo("client disconnected before the SSE response completed"),
			FailureStageClientCancelled) {
			s.deps.Metrics.RecordSSEClientDisconnect()
		}
	default:
		if s.finishLog(502, &message, stage) {
			s.deps.AutoWeight.RecordFailure(s.upstreamID, s.autoWeightEnabled, s.policy)
			s.deps.Metrics.RecordSSEUpstreamError()
		}
	}
}

// failureStage tells a stream that broke mid-answer from one that broke before
// saying anything.
//
// A stream only reaches this type after the first-event gate let it through, or
// with the gate disabled because no attempt was left to switch to. In the first
// case an event has been seen; in the second none may have been.
func (s *sseStream) failureStage() FailureStage {
	if s.observation.firstEventSeen {
		return FailureStageStream
	}
	return FailureStageFirstEvent
}

// finishLog writes the request log once. It reports false when another path
// already logged this stream.
//
// An empty stage means the stream succeeded, which leaves the column NULL.
func (s *sseStream) finishLog(statusCode int32, streamError *string, stage FailureStage) bool {
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
	entry.SetFailure(stage, statusCode)
	entry.UpstreamResponse = responseSnapshot
	entry.DownstreamResponse = responseSnapshot

	s.deps.LogWriter.Schedule(*entry)
	return true
}

func ptrTo[T any](value T) *T { return &value }
